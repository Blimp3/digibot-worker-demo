import { vi } from "vitest";

export function testFixedLengthStream(): number[] {
  const expectedLengths: number[] = [];
  class FixedLengthStreamForTest {
    readonly readable: ReadableStream<Uint8Array>;
    readonly writable: WritableStream<Uint8Array>;

    constructor(expectedLength: number) {
      expectedLengths.push(expectedLength);
      let received = 0;
      const transform = new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          received += chunk.byteLength;
          if (received > expectedLength) throw new TypeError("fixed stream overflow");
          controller.enqueue(chunk);
        },
        flush() {
          if (received !== expectedLength) throw new TypeError("fixed stream underflow");
        },
      });
      this.readable = transform.readable;
      this.writable = transform.writable;
    }
  }
  vi.stubGlobal("FixedLengthStream", FixedLengthStreamForTest);
  return expectedLengths;
}
