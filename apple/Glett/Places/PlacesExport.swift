import CoreTransferable
import Foundation
import UniformTypeIdentifiers

/// The saved places as the web's export file `glett-locations.json` (js/app.js:1541-1546), for `ShareLink`.
struct PlacesExport: Transferable {
    let data: Data

    static let filename = "glett-locations.json"

    static var transferRepresentation: some TransferRepresentation {
        FileRepresentation(exportedContentType: .json) { export in
            let url = FileManager.default.temporaryDirectory.appending(path: filename)
            try export.data.write(to: url, options: .atomic)
            return SentTransferredFile(url)
        }
    }
}
