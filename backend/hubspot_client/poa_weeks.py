"""Which week each row of a POA schedule belongs to, read from the PDF's own table borders.

The WEEK column uses merged cells: one cell spans several rows and its label ("Week 1") is printed once, on whichever
of those rows the author aligned it to (often the last). Reading the text alone can't tell which rows a label covers,
and guessing by position or by date gets it wrong. The borders can: a horizontal border crosses the WEEK column only
where one week's cell ends and the next begins, so a row belongs to the week whose cell it sits in, and to no week
when its cell has no label.
"""

from __future__ import annotations

import io

import pdfplumber

_FLAT = 1.5  # points: a border is a line, or a rectangle / curve no taller than this
_SAME_LINE = 3.0  # points: words this close vertically are on one line


def _mid(word: dict) -> float:
    return (word["x0"] + word["x1"]) / 2


def _centre(word: dict) -> float:
    return (word["top"] + word["bottom"]) / 2


def _page_rows(page) -> list[tuple[str, str]] | None:
    """(date cell text, week label or "") for each line of the DATE column, top to bottom. None when the page has no
    WEEK and DATE column headers side by side, or a week label's cell can't be made out: then nothing is claimed."""
    words = page.extract_words()
    for week in (w for w in words if w["text"].lower() == "week"):
        line = sorted((w for w in words if abs(w["top"] - week["top"]) < _SAME_LINE and w["x0"] > week["x0"]), key=_mid)
        if line and line[0]["text"].lower() == "date":
            break
    else:
        return None
    date = line[0]
    left = (_mid(week) + _mid(date)) / 2  # where the WEEK column ends and the DATE column begins
    right = (_mid(date) + _mid(line[1])) / 2 if len(line) > 1 else date["x1"] + (_mid(date) - left)
    below = [w for w in words if w["top"] > week["bottom"]]

    borders = sorted(
        (o["top"] + o["bottom"]) / 2
        for o in page.lines + page.rects + page.curves
        if o["bottom"] - o["top"] <= _FLAT and o["x0"] <= _mid(week) <= o["x1"]
    )
    cells: list[tuple[float, float, str]] = []  # (top, bottom, "Week 1")
    for i, word in enumerate(below):
        if word["text"].lower() != "week" or _mid(word) >= left or i + 1 == len(below):
            continue
        number = below[i + 1]
        if not number["text"].isdigit() or abs(number["top"] - word["top"]) >= _SAME_LINE:
            continue
        y = _centre(word)
        above, under = [b for b in borders if b < y], [b for b in borders if b > y]
        if not above or not under:
            return None
        cells.append((above[-1], under[0], f"{word['text']} {number['text']}"))
    if not cells:
        return None

    rows: list[tuple[float, list[dict]]] = []  # the DATE column's words, grouped into lines
    for word in sorted((w for w in below if left <= _mid(w) < right), key=lambda w: (w["top"], w["x0"])):
        if rows and abs(rows[-1][0] - _centre(word)) < _SAME_LINE:
            rows[-1][1].append(word)
        else:
            rows.append((_centre(word), [word]))
    return [
        (" ".join(w["text"] for w in line), next((label for top, bottom, label in cells if top < y < bottom), ""))
        for y, line in rows
    ]


def row_weeks(pdf: bytes) -> list[tuple[str, str]]:
    """Every DATE-column line of the schedule with the week its row sits in ("" for a row in no labelled week cell),
    in document order. Empty when the PDF has no WEEK / DATE table whose week cells can be read."""
    out: list[tuple[str, str]] = []
    with pdfplumber.open(io.BytesIO(pdf)) as document:
        for page in document.pages:
            out += _page_rows(page) or []
    return out
