#!/usr/bin/env python3
"""Generate quiz/public/template-questions.docx, the Word template teachers download,
fill in and upload to the HomPub Quiz host page.

Standard library only: zipfile plus a hand-written minimal WordprocessingML package
([Content_Types].xml, _rels/.rels, word/document.xml). Re-run after editing PARAGRAPHS:

    python3 quiz/test/make-template-docx.py

The output is byte-for-byte reproducible (fixed ZIP timestamps, fixed entry order), so
re-running it leaves git quiet unless the content changed. The parser that reads it is
quiz/public/import-text.js; its test suite checks that this file round-trips cleanly.

MIT License. Part of HomPub Quiz.
"""
import os
import sys
import zipfile
from xml.sax.saxutils import escape

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.normpath(os.path.join(HERE, "..", "public", "template-questions.docx"))

# (text, style). Styles: "title" (bold, large), "body" (plain), "note" (grey italic).
# An empty text is a blank paragraph, which the parser treats as a question separator.
PARAGRAPHS = [
    ("HomPub Quiz — question template", "title"),
    ("", "body"),
    ("1. Which organelle makes most of the cell's ATP?", "body"),
    ("A. Ribosome", "body"),
    ("B. Mitochondrion *", "body"),
    ("C. Golgi body", "body"),
    ("D. Nucleus", "body"),
    ("", "body"),
    ("2. Which gas do plants take in for photosynthesis?", "body"),
    ("A. Oxygen", "body"),
    ("B. Nitrogen", "body"),
    ("C. Carbon dioxide *", "body"),
    ("D. Helium", "body"),
    ("Time: 30", "body"),
    ("", "body"),
    ("3. Which planet is closest to the Sun?", "body"),
    ("A. Venus", "body"),
    ("B. Earth", "body"),
    ("C. Mercury", "body"),
    ("D. Mars", "body"),
    ("Answer: C", "body"),
    ("", "body"),
    (
        "Instructions: The first line of this document is the quiz title — replace it with yours. "
        "Type each question on its own line, numbered 1. 2. 3. …, with 2 to 4 options on the lines "
        "under it (A. B. C. D.). Mark the right option with a star (*) at the end of its line, or add a "
        "line \"Answer: C\" under the options. Optional lines: \"Time: 30\" (seconds: 5, 10, 15, 20, 30, 60, "
        "90, 120 or 240) and \"Points: 2000\" (double points) or \"Points: 0\" (survey, nobody scores). "
        "Leave a blank line between questions. Up to 100 questions. Paragraphs that start with "
        "\"Instructions:\" or \"Note:\" are ignored, so you can leave this one in. Then upload the file "
        "on the host page with \"Import Word / text\", or paste the text.",
        "note",
    ),
]

W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"


def run(text, bold=False, italic=False, size=None, color=None):
    props = ""
    if bold:
        props += "<w:b/><w:bCs/>"
    if italic:
        props += "<w:i/><w:iCs/>"
    if color:
        props += '<w:color w:val="%s"/>' % color
    if size:
        props += '<w:sz w:val="%d"/><w:szCs w:val="%d"/>' % (size, size)
    rpr = "<w:rPr>%s</w:rPr>" % props if props else ""
    return '<w:r>%s<w:t xml:space="preserve">%s</w:t></w:r>' % (rpr, escape(text))


def paragraph(text, style):
    if not text:
        return "<w:p/>"
    if style == "title":
        return '<w:p><w:pPr><w:spacing w:after="240"/></w:pPr>%s</w:p>' % run(text, bold=True, size=36)
    if style == "note":
        return '<w:p><w:pPr><w:spacing w:before="240"/></w:pPr>%s</w:p>' % run(text, italic=True, size=20, color="555555")
    return "<w:p>%s</w:p>" % run(text)


def document_xml():
    body = "".join(paragraph(text, style) for text, style in PARAGRAPHS)
    sect = (
        '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>'
        '<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/>'
        "</w:sectPr>"
    )
    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
        '<w:document xmlns:w="%s"><w:body>%s%s</w:body></w:document>' % (W_NS, body, sect)
    )


CONTENT_TYPES = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    '<Default Extension="xml" ContentType="application/xml"/>'
    '<Override PartName="/word/document.xml" '
    'ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
    "</Types>"
)

RELS = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    '<Relationship Id="rId1" '
    'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" '
    'Target="word/document.xml"/>'
    "</Relationships>"
)

DOCUMENT_RELS = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>'
)


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else OUT
    parts = [
        ("[Content_Types].xml", CONTENT_TYPES),
        ("_rels/.rels", RELS),
        ("word/document.xml", document_xml()),
        ("word/_rels/document.xml.rels", DOCUMENT_RELS),
    ]
    with zipfile.ZipFile(out, "w") as zf:
        for name, data in parts:
            info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            zf.writestr(info, data.encode("utf-8"))
    print("wrote %s (%d bytes, %d paragraphs)" % (out, os.path.getsize(out), len(PARAGRAPHS)))


if __name__ == "__main__":
    main()
