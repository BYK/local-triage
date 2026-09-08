# Local Triage Windows installer and native companion

This combined Windows x64 installer contains the Local Triage XPI and its
native-messaging host. The host runs both multilingual E5 embeddings and
Qwen3.5 0.8B event prose generation on native CPU through ONNX Runtime. The
models remain on the computer after their first download, and one persistent
host process shares their sessions across requests.

## Install

1. Close Thunderbird, then double-click
   `local-triage-windows-installer-0.13.9-win-x64.exe`.
2. Start Thunderbird. The installer places the matching XPI directly in the
   default profile's `extensions` directory.
3. Open Local Triage settings and run both model tests. The results should
   report native CPU.

The installer writes to `%LOCALAPPDATA%\LocalTriage\NativeHost`, verifies the
copied host version, stops older Local Triage host processes, registers the
current user's native-messaging entry, and updates the default Thunderbird
profile. No administrator access is required.

Fossilize embeds the XPI, JavaScript dependencies, CPU ONNX Runtime, and its
native binding in one executable. The host extracts the two native files to a
versioned `%LOCALAPPDATA%\LocalTriage\native-runtime` cache before use.

The multilingual E5 Q8 encoder is approximately 120 MB. The Qwen3.5 Q4 ONNX
graph is approximately 668 MB; Q4 keeps 4-bit weights with FP32 activations.
Real bilingual embedding and English/Turkish generation smoke tests must pass
before a release is packaged.
