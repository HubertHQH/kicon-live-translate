// Stateful resampling: carries phase and the final input sample between packets.
export class PCMResampler {
  constructor(rate, target = 16000) {
    this.ratio = rate / target;
    this.pending = [];
    this.position = 0;
  }
  push(input) {
    const data = new Float32Array(this.pending.length + input.length);
    data.set(this.pending);
    data.set(input, this.pending.length);
    const output = [];
    while (this.position + 1 < data.length) {
      const i = Math.floor(this.position),
        f = this.position - i;
      const x = Math.max(-1, Math.min(1, data[i] * (1 - f) + data[i + 1] * f));
      output.push(Math.round(x * (x < 0 ? 32768 : 32767)));
      this.position += this.ratio;
    }
    const consumed = Math.min(Math.floor(this.position), data.length);
    this.pending = data.slice(consumed);
    this.position -= consumed;
    return output;
  }
}
