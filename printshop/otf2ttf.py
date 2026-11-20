"""Convert a CFF-based OpenType font to TrueType outlines (quadratic), keeping metrics and cmap."""
import sys
from fontTools.ttLib import TTFont, newTable
from fontTools.pens.cu2quPen import Cu2QuPen
from fontTools.pens.ttGlyphPen import TTGlyphPen


def convert(src, dst):
    f = TTFont(src)
    gs = f.getGlyphSet()
    order = f.getGlyphOrder()
    glyf = newTable('glyf'); glyf.glyphOrder = order; glyf.glyphs = {}
    for g in order:
        pen = TTGlyphPen(gs)
        try:
            gs[g].draw(Cu2QuPen(pen, 1.0, reverse_direction=True))
            glyf.glyphs[g] = pen.glyph()
        except Exception:
            glyf.glyphs[g] = TTGlyphPen(gs).glyph()
    f['glyf'] = glyf
    f['loca'] = newTable('loca')
    del f['CFF ']
    if 'VORG' in f:
        del f['VORG']
    f['maxp'] = newTable('maxp'); m = f['maxp']
    m.tableVersion = 0x00010000; m.numGlyphs = len(order)
    for k in ('maxZones', 'maxTwilightPoints', 'maxStorage', 'maxFunctionDefs', 'maxInstructionDefs', 'maxStackElements', 'maxSizeOfInstructions', 'maxComponentElements', 'maxPoints', 'maxContours', 'maxCompositePoints', 'maxCompositeContours', 'maxComponentDepth'):
        setattr(m, k, 0)
    m.maxZones = 1
    f['head'].glyphDataFormat = 0
    f['head'].indexToLocFormat = 0
    p = f['post']; p.formatType = 2.0; p.extraNames = []; p.mapping = {}
    p.glyphOrder = order
    f.sfntVersion = '\x00\x01\x00\x00'
    f.save(dst)
    # recalc bounds / maxp
    t = TTFont(dst); t.save(dst)


if __name__ == '__main__':
    convert(sys.argv[1], sys.argv[2])
