# Helpers for build.mjs (PyMuPDF):
#   postpdf.py pages  <pdf>                    -> JSON {anchor id: page number} from the PDF's named destinations
#   postpdf.py finish <pdf> <out.pdf> <html>   -> bookmarks from the headings, document properties, saved as out.pdf
import json
import re
import sys

import pymupdf


def anchor_pages(doc):
    out = {}
    for name, d in doc.resolve_names().items():
        if isinstance(d, dict) and d.get('page', -1) >= 0:
            out[name] = d['page'] + 1
    return out


def main():
    cmd = sys.argv[1]
    doc = pymupdf.open(sys.argv[2])
    pages = anchor_pages(doc)
    if cmd == 'pages':
        print(json.dumps(pages))
        return
    out, html = sys.argv[3], open(sys.argv[4], encoding='utf-8').read()
    if len(sys.argv) > 5:   # the cover, printed full bleed on its own, replaces the placeholder first page
        cover = pymupdf.open(sys.argv[5])
        doc.insert_pdf(cover, from_page=0, to_page=0, start_at=0)
        doc.delete_page(1)
    toc = [[1, 'الغلاف', 1], [1, 'المحتويات', pages.get('toc', 2)]]
    for lvl, hid, inner in re.findall(r'<h([12])[^>]*\bid="([^"]+)"[^>]*>(.*?)</h\1>', html, re.S):
        n = re.search(r'<span class="n">(.*?)</span>', inner)
        text = re.sub(r'<[^>]+>', '', re.sub(r'<span class="n">.*?</span>', '', inner)).strip()
        if hid in pages:
            toc.append([int(lvl), (n.group(1) + '  ' if n else '') + text, pages[hid]])
    doc.set_toc(toc)
    doc.set_metadata({
        'title': 'ستيتشلاين — دليل المستخدم',
        'author': 'Stitchline',
        'subject': 'دليل استخدام برنامج ستيتشلاين 1.0.0 لماكينات خياطة الباترون وقص الليزر',
        'keywords': 'Stitchline, SLW, دليل المستخدم, خياطة الباترون, قص الليزر',
        'creator': 'Stitchline manual build (HTML + Microsoft Edge)',
        'producer': 'Microsoft Edge / PyMuPDF',
    })
    doc.set_pagemode('UseOutlines')
    doc.save(out, garbage=3, deflate=True)
    print(f'{out}: {doc.page_count} pages, {len(toc)} bookmarks')


main()
