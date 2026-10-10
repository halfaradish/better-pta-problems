# 生成扩展图标：圆角方块 + “题”字
Add-Type -AssemblyName System.Drawing
$out = Join-Path $PSScriptRoot '..\extension\icons'
New-Item -ItemType Directory -Force -Path $out | Out-Null

foreach ($size in 16, 48, 128) {
  $bmp = New-Object System.Drawing.Bitmap $size, $size
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'
  $g.TextRenderingHint = 'AntiAliasGridFit'
  $g.Clear([System.Drawing.Color]::Transparent)

  $r = [Math]::Max(2, [int]($size * 0.22))
  $d = $size - 1
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $path.AddArc(0, 0, $r * 2, $r * 2, 180, 90)
  $path.AddArc($d - $r, 0, $r * 2, $r * 2, 270, 90)
  $path.AddArc($d - $r, $d - $r, $r * 2, $r * 2, 0, 90)
  $path.AddArc(0, $d - $r, $r * 2, $r * 2, 90, 90)
  $path.CloseFigure()
  $brush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 10, 73, 145))
  $g.FillPath($brush, $path)

  $font = New-Object System.Drawing.Font('Microsoft YaHei', [float]($size * 0.58), [System.Drawing.GraphicsUnit]::Pixel)
  $sf = New-Object System.Drawing.StringFormat
  $sf.Alignment = 'Center'; $sf.LineAlignment = 'Center'
  $rect = New-Object System.Drawing.RectangleF 0, ([float](-$size * 0.03)), $size, $size
  $glyph = [string][char]0x9898  # U+9898
  $g.DrawString($glyph, $font, [System.Drawing.Brushes]::White, $rect, $sf)

  $bmp.Save((Join-Path $out "icon$size.png"), [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
  Write-Host "icon$size.png OK"
}
