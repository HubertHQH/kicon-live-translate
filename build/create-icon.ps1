Add-Type -AssemblyName System.Drawing
$iconFolder = $PSScriptRoot
$canvas = [System.Drawing.Bitmap]::new(256, 256)
$graphics = [System.Drawing.Graphics]::FromImage($canvas)
$graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$graphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
$graphics.Clear([System.Drawing.ColorTranslator]::FromHtml('#192923'))
$ink = [System.Drawing.SolidBrush]::new([System.Drawing.ColorTranslator]::FromHtml('#edf2e6'))
$accent = [System.Drawing.SolidBrush]::new([System.Drawing.ColorTranslator]::FromHtml('#d7e8bd'))
$gold = [System.Drawing.SolidBrush]::new([System.Drawing.ColorTranslator]::FromHtml('#c69743'))
$font = [System.Drawing.Font]::new('Segoe UI', 130, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
$graphics.DrawString('K', $font, $ink, 62, 12)
$graphics.FillRectangle($accent, 48, 177, 160, 12)
$graphics.FillRectangle($gold, 48, 207, 112, 12)
$images = [System.Collections.Generic.List[byte[]]]::new()
$sizes = @(16, 24, 32, 48, 64, 128, 256)
foreach ($size in $sizes) {
  $bitmap = [System.Drawing.Bitmap]::new($size, $size)
  $g = [System.Drawing.Graphics]::FromImage($bitmap)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.DrawImage($canvas, 0, 0, $size, $size)
  $memory = [System.IO.MemoryStream]::new()
  $bitmap.Save($memory, [System.Drawing.Imaging.ImageFormat]::Png)
  $images.Add($memory.ToArray())
  $memory.Dispose(); $g.Dispose(); $bitmap.Dispose()
}
$stream = [System.IO.File]::Create((Join-Path $iconFolder 'icon.ico'))
$writer = [System.IO.BinaryWriter]::new($stream)
$writer.Write([uint16]0); $writer.Write([uint16]1); $writer.Write([uint16]$sizes.Count)
$offset = 6 + 16 * $sizes.Count
for ($i = 0; $i -lt $sizes.Count; $i++) {
  $dimension = if ($sizes[$i] -eq 256) { 0 } else { $sizes[$i] }
  $writer.Write([byte]$dimension); $writer.Write([byte]$dimension)
  $writer.Write([byte]0); $writer.Write([byte]0)
  $writer.Write([uint16]1); $writer.Write([uint16]32)
  $writer.Write([uint32]$images[$i].Length); $writer.Write([uint32]$offset)
  $offset += $images[$i].Length
}
foreach ($bytes in $images) { $writer.Write($bytes) }
$writer.Dispose(); $stream.Dispose()
$font.Dispose(); $ink.Dispose(); $accent.Dispose(); $gold.Dispose(); $graphics.Dispose(); $canvas.Dispose()
