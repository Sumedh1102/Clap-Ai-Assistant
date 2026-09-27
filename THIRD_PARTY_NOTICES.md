# Third-party notices

CLAP's architecture was informed by **jarvis** by Aditya Dewaskar
(<https://github.com/adewaskar/jarvis>), released under the MIT License.
CLAP does not copy its files. Where a technique is re-implemented closely, the
CLAP source file says so in its header comment:

| CLAP file | Technique |
|---|---|
| `bridge/security/ssrf.ts` | SSRF gate: address table, resolve-once DNS hook, vetted redirects |
| `src/voice/vad.ts` | Energy VAD approach and starting constants |
| `src/voice/endpointing.ts` | Word-aware endpointing on top of an energy gate |
| `src/voice/stt/webspeech.ts` | Self-restarting Web Speech recogniser with a quiet-session heartbeat |
| `src/voice/tts/browser.ts` | `speechSynthesis` reliability workarounds |

The notice below applies to those techniques as they appear in the reference.

```
MIT License

Copyright (c) 2026 Aditya Dewaskar

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
