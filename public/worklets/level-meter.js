/**
 * CLAP microphone level meter (AudioWorklet).
 *
 * Posts the RMS energy of each ~20 ms of microphone audio to the main thread,
 * where the voice-activity detector runs. Running on the audio thread keeps
 * detection steady even when the tab is in the background and animation
 * frames are throttled.
 */
class ClapLevelMeter extends AudioWorkletProcessor {
  constructor() {
    super()
    this.sum = 0
    this.count = 0
    this.window = Math.max(128, Math.round(sampleRate * 0.02))
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0]
    if (channel) {
      for (let i = 0; i < channel.length; i++) this.sum += channel[i] * channel[i]
      this.count += channel.length
      if (this.count >= this.window) {
        // A MessagePort, not window.postMessage: there is no target origin.
        // oxlint-disable-next-line unicorn/require-post-message-target-origin
        this.port.postMessage(Math.sqrt(this.sum / this.count))
        this.sum = 0
        this.count = 0
      }
    }
    return true
  }
}

registerProcessor('clap-level-meter', ClapLevelMeter)
