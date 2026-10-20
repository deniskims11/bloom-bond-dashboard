import zipfile, xml.etree.ElementTree as ET
NS = {'m': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}

def col_idx(ref):
    s = ''.join(ch for ch in ref if ch.isalpha())
    n = 0
    for ch in s:
        n = n * 26 + (ord(ch) - 64)
    return n - 1

def read_sheet(path, sheet_file):
    z = zipfile.ZipFile(path)
    shared = []
    if 'xl/sharedStrings.xml' in z.namelist():
        ss = ET.fromstring(z.read('xl/sharedStrings.xml'))
        for si in ss.findall('m:si', NS):
            shared.append(''.join(t.text or '' for t in si.iter('{%s}t' % NS['m'])))
    root = ET.fromstring(z.read(sheet_file))
    rows = []
    for row in root.findall('.//m:sheetData/m:row', NS):
        cells = {}
        for c in row.findall('m:c', NS):
            ref = c.get('r') or ''
            t = c.get('t')
            v = c.find('m:v', NS)
            isel = c.find('m:is', NS)
            if isel is not None:
                val = ''.join(x.text or '' for x in isel.iter('{%s}t' % NS['m']))
            elif v is None:
                val = None
            elif t == 's':
                val = shared[int(v.text)] if v.text and v.text.isdigit() else None
            else:
                val = v.text
            cells[col_idx(ref)] = val
        if cells:
            width = max(cells) + 1
            rows.append([cells.get(i) for i in range(width)])
    return rows
