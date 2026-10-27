import CoreGraphics; import ImageIO; import Foundation; import UniformTypeIdentifiers
// The dog-walk pictures for the asset catalogue (apple/docs/DOG-WALK-ART.md): `swiftc -O dogart.swift -o dogart`, then
// `dogart in.png out.jpg colour 540` or `dogart in-lock.png out-lock.png lock 300`.
// usage: dogart <in.png> <out> colour|lock <size>
let a = CommandLine.arguments
let src = CGImageSourceCreateImageAtIndex(CGImageSourceCreateWithURL(URL(fileURLWithPath: a[1]) as CFURL, nil)!, 0, nil)!
let n = Int(a[4])!
let lock = a[3] == "lock"
let cs = lock ? CGColorSpaceCreateDeviceGray() : CGColorSpace(name: CGColorSpace.sRGB)!
let ctx = CGContext(data: nil, width: n, height: n, bitsPerComponent: 8, bytesPerRow: 0, space: cs,
                    bitmapInfo: lock ? CGImageAlphaInfo.none.rawValue : CGImageAlphaInfo.noneSkipLast.rawValue)!
ctx.interpolationQuality = .high
ctx.draw(src, in: CGRect(x: 0, y: 0, width: n, height: n))
var out = ctx.makeImage()!
if lock {
    // black on white → black with alpha = 1 − luminance (antialiasing kept)
    let g = ctx.data!.assumingMemoryBound(to: UInt8.self), bpr = ctx.bytesPerRow
    let rgba = CGContext(data: nil, width: n, height: n, bitsPerComponent: 8, bytesPerRow: n * 4, space: CGColorSpace(name: CGColorSpace.sRGB)!,
                         bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    let p = rgba.data!.assumingMemoryBound(to: UInt8.self)
    for y in 0..<n { for x in 0..<n {
        let l = Double(g[y * bpr + x]) / 255
        let alpha = UInt8(max(0, min(255, (1 - l) * 1.15 * 255)))   // a little firmer, so faint grey edges go
        let i = (y * n + x) * 4
        p[i] = 0; p[i + 1] = 0; p[i + 2] = 0; p[i + 3] = l > 0.92 ? 0 : alpha
    } }
    out = rgba.makeImage()!
}
let type = lock ? UTType.png : UTType.jpeg
let d = CGImageDestinationCreateWithURL(URL(fileURLWithPath: a[2]) as CFURL, type.identifier as CFString, 1, nil)!
CGImageDestinationAddImage(d, out, lock ? nil : [kCGImageDestinationLossyCompressionQuality: 0.86] as CFDictionary)
CGImageDestinationFinalize(d)
