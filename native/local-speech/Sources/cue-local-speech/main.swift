import Foundation
import FluidAudio

struct Request: Decodable {
    let id: Int
    let pcm: String
}

func respond(_ value: [String: Any]) {
    if let data = try? JSONSerialization.data(withJSONObject: value) {
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data([10]))
    }
}

@main struct CueLocalSpeech {
    static func main() async {
        do {
            guard CommandLine.arguments.count == 2 else {
                throw NSError(domain: "Cue", code: 1, userInfo: [NSLocalizedDescriptionKey: "A local model folder is required."])
            }
            let directory = URL(fileURLWithPath: CommandLine.arguments[1])
            let models = try await AsrModels.load(from: directory, version: .v2)
            let manager = AsrManager()
            try await manager.loadModels(models)
            respond(["ready": true])
            while let line = readLine() {
                var requestID = -1
                do {
                    let request = try JSONDecoder().decode(Request.self, from: Data(line.utf8))
                    requestID = request.id
                    guard let bytes = Data(base64Encoded: request.pcm), !bytes.isEmpty,
                          bytes.count % 2 == 0, bytes.count <= 960_000 else {
                        throw NSError(domain: "Cue", code: 2, userInfo: [NSLocalizedDescriptionKey: "Expected at most 30 seconds of mono 16 kHz PCM16."])
                    }
                    // The IPC contract is raw little-endian PCM16, not a WAV container.
                    let samples: [Float] = stride(from: 0, to: bytes.count, by: 2).map { offset in
                        Float(Int16(bitPattern: UInt16(bytes[offset]) | UInt16(bytes[offset + 1]) << 8)) / 32768
                    }
                    var decoderState = try TdtDecoderState(decoderLayers: 2)
                    let result = try await manager.transcribe(samples, decoderState: &decoderState)
                    respond(["id": request.id, "text": result.text])
                } catch {
                    respond(["id": requestID, "error": error.localizedDescription])
                }
            }
        } catch {
            respond(["error": error.localizedDescription])
            exit(1)
        }
    }
}
