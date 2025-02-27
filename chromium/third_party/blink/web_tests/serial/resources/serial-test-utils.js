// Returns a SerialPort instance and associated FakeSerialPort instance.
async function getFakeSerialPort(fake) {
  let token = fake.addPort();
  let fakePort = fake.getFakePort(token);

  let ports = await navigator.serial.getPorts();
  assert_equals(ports.length, 1);

  let port = ports[0];
  assert_true(port instanceof SerialPort);

  return { port, fakePort };
}

// Compare two Uint8Arrays.
function compareArrays(actual, expected) {
  assert_true(actual instanceof Uint8Array, 'actual is Uint8Array');
  assert_true(expected instanceof Uint8Array, 'expected is Uint8Array');
  assert_equals(actual.byteLength, expected.byteLength, 'lengths equal');
  for (let i = 0; i < expected.byteLength; ++i)
    assert_equals(actual[i], expected[i], `Mismatch at position ${i}.`);
}

// Pull from |reader| until it reports done and return the data as a combined
// Uint8Array.
async function readAll(reader) {
  const chunks = [];
  while (true) {
    let { value, done } = await reader.read();
    if (done) {
      // It would be better to allocate |buffer| up front with the number of
      // of bytes expected but this is the best that can be done without a BYOB
      // reader to control the amount of data read.
      const length =
          chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
      const buffer = new Uint8Array(length);
      chunks.reduce((offset, chunk) => {
        buffer.set(chunk, offset);
        return offset + chunk.byteLength;
      }, 0);
      return buffer;
    }

    chunks.push(value);
  }
}

// Implementation of an UnderlyingSource to create a ReadableStream from a Mojo
// data pipe consumer handle.
class DataPipeSource {
  constructor(consumer) {
    this.consumer_ = consumer;
  }

  async pull(controller) {
    let chunk = new ArrayBuffer(64);
    let {result, numBytes} = this.consumer_.readData(chunk);
    if (result == Mojo.RESULT_OK) {
      controller.enqueue(new Uint8Array(chunk, 0, numBytes));
      return;
    } else if (result == Mojo.RESULT_FAILED_PRECONDITION) {
      controller.close();
      return;
    } else if (result == Mojo.RESULT_SHOULD_WAIT) {
      await this.readable();
      return this.pull(controller);
    }
  }

  cancel() {
    this.watcher_.cancel();
    this.consumer_.close();
  }

  readable() {
    return new Promise((resolve) => {
      this.watcher_ =
          this.consumer_.watch({ readable: true, peerClosed: true }, () => {
            this.watcher_.cancel();
            this.watcher_ = undefined;
            resolve();
          });
    });
  }
}

// Implementation of an UnderlyingSink to create a WritableStream from a Mojo
// data pipe producer handle.
class DataPipeSink {
  constructor(producer) {
    this._producer = producer;
  }

  async write(chunk, controller) {
    let {result, numBytes} = this._producer.writeData(chunk);
    if (result == Mojo.RESULT_OK) {
      if (numBytes < chunk.byteLength)
        return this.write(chunk.slice(numBytes), controller);
    } else if (result == Mojo.RESULT_FAILED_PRECONDITION) {
      throw new DOMException("The pipe is closed.", "InvalidStateError");
    } else if (result == Mojo.RESULT_SHOULD_WAIT) {
      await this.writable();
      return this.write(chunk, controller);
    }
  }

  close() {
    assert_equals(undefined, this._watcher);
    this._producer.close();
  }

  abort(reason) {
    if (this._watcher)
      this._watcher.cancel();
    this._producer.close();
  }

  writable() {
    return new Promise((resolve) => {
      this._watcher =
          this._producer.watch({ writable: true, peerClosed: true }, () => {
            this._watcher.cancel();
            this._watcher = undefined;
            resolve();
          });
    });
  }
}

// Implementation of blink.mojom.SerialPort.
class FakeSerialPort {
  constructor() {}

  bind(request) {
    assert_equals(this.binding, undefined, 'Port is still open');
    this.binding = new mojo.Binding(device.mojom.SerialPort,
                                    this, request);
    this.binding.setConnectionErrorHandler(() => {
      this.writable_.getWriter().close();
      this.binding = undefined;
    });
  }

  write(data) {
    let writer = this.writable_.getWriter();
    writer.write(data);
    writer.releaseLock();
  }

  async read() {
    let reader = this.readable_.getReader();
    let result = await reader.read();
    reader.releaseLock();
    return result;
  }

  simulateParityError() {
    this.writable_.getWriter().close();
    this.writable_ = undefined;
    this.client_.onReadError(device.mojom.SerialReceiveError.PARITY_ERROR);
  }

  waitForErrorCleared() {
    if (this.writable_)
      return Promise.resolve();

    if (!this.errorClearedPromise_) {
      this.errorClearedPromise_ = new Promise((resolve) => {
        this.errorCleared_ = resolve;
      });
    }

    return this.errorClearedPromise_;
  }

  async open(options, in_stream, out_stream, client) {
    this.options_ = options;
    this.client_ = client;
    this.readable_ = new ReadableStream(new DataPipeSource(in_stream));
    this.writable_ = new WritableStream(new DataPipeSink(out_stream));
    return { success: true };
  }

  async clearSendError(in_stream) {}

  async clearReadError(out_stream) {
    this.writable_ = new WritableStream(new DataPipeSink(out_stream));
    if (this.errorCleared_)
      this.errorCleared_();
  }

  async flush() {
    return { success: false };
  }

  async getControlSignals() {
    return { signals: { dcd: false, cts: false, ri: false, dsr: false } };
  }

  async setControlSignals(signals) {
    return { success: false };
  }

  async configurePort(options) {
    this.options_ = options;
    return { success: true };
  }

  async getPortInfo() {
    return {
      bitrate: this.options_.bitrate,
      data_bits: this.options_.data_bits,
      parity_bit: this.options_.parity_bit,
      stop_bits: this.options_.stop_bits,
      cts_flow_control: this.options_.has_cts_flow_control ?
          this.options_.cts_flow_control : false
    };
  }

  async setBreak() {
    return { success: false };
  }

  async clearBreak() {
    return { success: false };
  }
}

// Implementation of blink.mojom.SerialService.
class FakeSerialService {
  constructor() {
    this.interceptor_ =
        new MojoInterfaceInterceptor(blink.mojom.SerialService.name);
    this.interceptor_.oninterfacerequest = e => this.bind(e.handle);
    this.bindingSet_ = new mojo.BindingSet(blink.mojom.SerialService);
    this.nextToken_ = 0;
    this.reset();
  }

  start() {
    this.interceptor_.start();
  }

  stop() {
    this.interceptor_.stop();
  }

  reset() {
    this.ports_ = new Map();
    this.selectedPort_ = null;
  }

  addPort(vendorId, productId) {
    let info = new blink.mojom.SerialPortInfo();
    if (vendorId !== undefined) {
      info.hasVendorId = true;
      info.vendorId = vendorId;
    }
    if (productId !== undefined) {
      info.hasProductId = true;
      info.productId = productId;
    }
    let token = ++this.nextToken_;
    info.token = new mojoBase.mojom.UnguessableToken();
    info.token.high = 0;
    info.token.low = token;
    let record = {
      portInfo: info,
      fakePort: new FakeSerialPort(),
    };
    this.ports_.set(token, record);
    return token;
  }

  removePort(token) {
    this.ports_.delete(token);
  }

  setSelectedPort(token) {
    this.selectedPort_ = this.ports_.get(token);
  }

  getFakePort(token) {
    let record = this.ports_.get(token);
    if (record === undefined)
      return undefined;
    return record.fakePort;
  }

  bind(handle) {
    this.bindingSet_.addBinding(this, handle);
  }

  async getPorts() {
    return {
      ports: Array.from(this.ports_, ([token, record]) => record.portInfo)
    };
  }

  async requestPort(filters) {
    if (this.selectedPort_)
      return { port: this.selectedPort_.portInfo };
    else
      return { port: null };
  }

  async getPort(token, port_request) {
    let record = this.ports_.get(token.low);
    if (record !== undefined) {
      record.fakePort.bind(port_request);
    } else {
      port_request.close();
    }
  }
}

let fakeSerialService = new FakeSerialService();

function serial_test(func, name, properties) {
  promise_test(async (test) => {
    fakeSerialService.start();
    try {
      await func(test, fakeSerialService);
    } finally {
      fakeSerialService.stop();
      fakeSerialService.reset();
    }
  }, name, properties);
}

function trustedClick() {
  return new Promise(resolve => {
    let button = document.createElement('button');
    button.textContent = 'click to continue test';
    button.style.display = 'block';
    button.style.fontSize = '20px';
    button.style.padding = '10px';
    button.onclick = () => {
      document.body.removeChild(button);
      resolve();
    };
    document.body.appendChild(button);
    test_driver.click(button);
  });
}
