export class AudioCapture {
  constructor(onPCM, onLevel, onEnded) {
    this.onPCM = onPCM;
    this.onLevel = onLevel;
    this.onEnded = onEnded;
  }
  async prepare(kind, deviceId) {
    if (!navigator.mediaDevices)
      throw new Error(
        "音频采集需要 localhost 或 HTTPS，请在本机 Chrome / Edge 中打开。",
      );
    try {
      this.context = new AudioContext({ sampleRate: 16000, latencyHint: "interactive" });
      await this.context.resume();
      this.stream =
        kind === "system"
          ? await navigator.mediaDevices.getDisplayMedia({
              video: true,
              audio: true,
              systemAudio: "include",
            })
          : await navigator.mediaDevices.getUserMedia({
              audio: {
                deviceId: deviceId ? { exact: deviceId } : undefined,
                channelCount: 1,
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true,
              },
            });
      if (!this.stream.getAudioTracks().length)
        throw new Error(
          "没有共享音频。请重新选择屏幕或标签页，并勾选“共享音频”。",
        );
      this.stream
        .getTracks()
        .forEach((t) => t.addEventListener("ended", () => this.onEnded()));
      await this.context.audioWorklet.addModule("/pcm-worklet.js");
      this.node = new AudioWorkletNode(this.context, "pcm-recorder");
      this.node.port.onmessage = ({ data }) => {
        if (data.flushed) this.resolveFlush?.();
        if (data.pcm) this.onPCM(data.pcm);
        if (data.level !== undefined) this.onLevel(data.level);
      };
      // Only audio tracks enter the graph. Screen video is never sent or stored.
      this.source = this.context.createMediaStreamSource(
        new MediaStream(this.stream.getAudioTracks()),
      );
      this.filter = this.context.createBiquadFilter();
      this.filter.type = "lowpass";
      this.filter.frequency.value = 7000;
      this.filter.Q.value = 0.707;
      this.mute = this.context.createGain();
      this.mute.gain.value = 0;
    } catch (e) {
      await this.stop();
      throw e;
    }
  }
  start() {
    this.source
      .connect(this.filter)
      .connect(this.node)
      .connect(this.mute)
      .connect(this.context.destination);
  }
  async stop() {
    if (this.node && this.context?.state === "running") {
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 500);
        this.resolveFlush = () => {
          clearTimeout(timer);
          resolve();
        };
        this.node.port.postMessage("flush");
      });
    }
    this.stream?.getTracks().forEach((t) => t.stop());
    this.source?.disconnect();
    this.node?.disconnect();
    if (this.context && this.context.state !== "closed")
      await this.context.close();
    this.onLevel(0);
  }
}
