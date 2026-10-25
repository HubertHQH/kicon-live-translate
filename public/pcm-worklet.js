import { PCMResampler } from "./resampler.js";
class PCMRecorder extends AudioWorkletProcessor {
  constructor() {
    super();
    this.resampler = new PCMResampler(sampleRate);
    this.samples = [];
    this.enabled = true;
    this.port.onmessage = (e) => {
      if (e.data === "flush") {
        this.enabled = false;
        this.emit();
        this.port.postMessage({ flushed: true });
      }
    };
  }
  emit() {
    if (!this.samples.length) return;
    const buffer = new ArrayBuffer(this.samples.length * 2),
      view = new DataView(buffer);
    this.samples.forEach((n, i) => view.setInt16(i * 2, n, true));
    this.samples = [];
    this.port.postMessage({ pcm: buffer }, [buffer]);
  }
  process(inputs) {
    const channels = inputs[0];
    if (!this.enabled || !channels?.length) return true;
    const mono = new Float32Array(channels[0].length);
    let sum = 0;
    for (let i = 0; i < mono.length; i++) {
      for (const channel of channels) mono[i] += channel[i] / channels.length;
      sum += mono[i] * mono[i];
    }
    this.samples.push(...this.resampler.push(mono));
    // Forward about 50 ms at a time; do not wait for sentence boundaries.
    if (this.samples.length >= 800) {
      this.port.postMessage({ level: Math.sqrt(sum / mono.length) });
      this.emit();
    }
    return true;
  }
}
registerProcessor("pcm-recorder", PCMRecorder);
