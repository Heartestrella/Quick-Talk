// Runs in AudioWorkletGlobalScope. AudioContext must be created at 16000 Hz
// so the input already arrives at 16 kHz mono. Each process() call gets 128
// samples (~8 ms); we accumulate to a 320-sample (20 ms) frame, convert to
// Int16 PCM, and hand it to the main thread as a transferable ArrayBuffer.
class PCMCapturer extends AudioWorkletProcessor {
  constructor() {
    super()
    this.frame = new Float32Array(320)
    this.idx = 0
  }
  process(inputs) {
    const input = inputs[0] && inputs[0][0]
    if (!input) return true
    for (let i = 0; i < input.length; i++) {
      this.frame[this.idx++] = input[i]
      if (this.idx === this.frame.length) {
        const int16 = new Int16Array(this.frame.length)
        for (let j = 0; j < this.frame.length; j++) {
          let s = this.frame[j]
          if (s > 1) s = 1
          else if (s < -1) s = -1
          int16[j] = s < 0 ? s * 32768 : s * 32767
        }
        this.port.postMessage(int16.buffer, [int16.buffer])
        this.idx = 0
      }
    }
    return true
  }
}
registerProcessor('pcm-capturer', PCMCapturer)
