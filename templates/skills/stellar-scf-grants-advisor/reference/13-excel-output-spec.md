# Excel deliverable specification

Every review produces a single Excel file with four sheets. This document is the canonical spec.

## File naming

`{ProjectName}_{Phase}_Review_v{N}.xlsx`

Examples:
- `Antevorta_Abstract_Review_v2.xlsx`
- `SolarBraves_Build_Review_v1.xlsx`
- `Tickie_Abstract_Review_v3.xlsx`

Always increment the version when you produce a revised review.

## Sheet 1: Field-by-Field Review

The main sheet. Where the client sees, for each field of their Abstract or Build, what is good and what needs to change.

### Columns

1. **Field** (column A), the Q-number plus field name. Examples: `Q2 Description`, `Q10 Team`, `Q15 Budget Total`.

2. **Status** (column B), short status code: `STRONG`, `SOLID`, `UNDERSELLING`, `WEAK`, `BLOCKER`.

3. **Review** (column C), French or English commentary explaining what we see and why. Use the three-part structure from `12-client-communication.md`. Reference past dossiers by name. Do NOT use "kill signature".

4. **Rewrite / Action** (column D), paste-ready English text the client can copy directly into the SCF form. For non-rewrite actions (a thumbnail upload, a Discord username fix), describe the action specifically.

### Formatting

- Column widths: A=22, B=20, C=70, D=80.
- Header row: bold, white text on Stellar dark blue (`#0E1116`).
- Status cells: color-coded background (STRONG=green, SOLID=light green, UNDERSELLING=yellow, WEAK=orange, BLOCKER=red).
- Text wrap: wrap on columns C and D.
- Row height: auto-fit (or 60-80 px for long rewrites).
- Borders: thin gray on all cells.

### Banner row (above the field rows)

Row 1 is a banner spanning columns A-D:
- Project name in big bold.
- One-line headline verdict, including: estimated probability of acceptance now, estimated probability after fixes, recommended budget anchor.

Example banner text:
> *"Antevorta Gold Abstract Review v2: estimated 35-45 percent probability of acceptance as currently drafted, lifting to 65-75 percent after the seven fixes below. Recommended budget anchor: $100K to $115K Integration Track, between Bando ($75K winner SCF #42) and Rebond (target $132K SCF #44)."*

## Sheet 2: Pre-submission Checklist

A prioritized action list. The client uses this as their pre-submit checklist.

### Columns

1. **Priority** (column A), `BLOCKER`, `CRITICAL`, `IMPORTANT`, `STRATEGIC`.

2. **Item** (column B), short action description.

3. **Field** (column C), which SCF field this action targets.

4. **Effort** (column D), `15 min`, `1h`, `1 day`, `3 days`, `1 week`.

5. **Why it matters** (column E), one sentence explaining the impact on acceptance probability.

6. **Status** (column F), empty for the client to tick off (`Done`, `In progress`, `Skipped`).

### Sorting

BLOCKER items first, then CRITICAL, then IMPORTANT, then STRATEGIC. Within each tier, the highest-impact-to-effort ratio first.

## Sheet 3: Corpus Comparables

Side-by-side comparison of the client's dossier with 10 to 15 past submissions. Helps the client see where they sit.

### Columns

1. **Project** (column A), past submission name.
2. **Round** (column B), SCF #40, #41, #42, #44.
3. **Budget** (column C), amount requested.
4. **Verdict** (column D), `Won`, `Rejected`, `Panel Review Failed`, `Information Collection`.
5. **Category** (column E), what category the past submission was in.
6. **Profile snapshot** (column F), one sentence on team, scope, traction.
7. **Lesson for current dossier** (column G), one sentence on what this past dossier tells us about the current one.

### Selection rule

Pick comparables that match the current dossier on at least one of: category, budget range, team size, regulatory profile. Include both winners and rejects so the contrast is informative.

The first row should ALWAYS be the current dossier itself (with "TBD" in Verdict column), then comparables sorted with closest comparable first.

## Sheet 4: Integration List Audit

Audit of the dossier's usage of the official SCF Integration List.

### Columns

1. **Category** (column A), `On/Off-ramping`, `DeFi`, `Cross-chain`, `Payments`, `Wallets`, `Other`.

2. **Item** (column B), the Integration List item name.

3. **Status in dossier** (column C), `MENTIONED`, `TO ADD`, `OPTIONAL`, `NOT RELEVANT`.

4. **Recommendation** (column D), specific guidance on whether and how to add.

5. **Integration effort** (column E), `< 1 day`, `1-5 days`, `1-2 weeks`, `1+ month`.

### Rule

For each item on the Integration List (the table in `07-integration-list.md`), decide its status for the current dossier:
- `MENTIONED`: the dossier already cites it in Q6 Integration Description.
- `TO ADD`: the dossier would clearly benefit from adding it. Explain why in Recommendation column.
- `OPTIONAL`: the dossier could add it for additional credit. Explain when in Recommendation column.
- `NOT RELEVANT`: the item does not fit the dossier's use case.

## Generation: openpyxl boilerplate

The skill's `templates/` folder contains build scripts (`abstract-review-builder.py` and `build-review-builder.py`) that scaffold the four sheets. Use these as the starting point for every review.

Key openpyxl patterns:

```python
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side

wb = Workbook()
ws1 = wb.active
ws1.title = "Abstract Review"

# Banner row
ws1.merge_cells('A1:D1')
ws1['A1'] = banner_text
ws1['A1'].font = Font(bold=True, color="FFFFFF", size=14)
ws1['A1'].fill = PatternFill(start_color="0E1116", fill_type="solid")
ws1.row_dimensions[1].height = 80

# Headers
headers = ["Field", "Status", "Review", "Rewrite / Action"]
for col, h in enumerate(headers, start=1):
    cell = ws1.cell(row=2, column=col, value=h)
    cell.font = Font(bold=True, color="FFFFFF")
    cell.fill = PatternFill(start_color="0E1116", fill_type="solid")

# Column widths
ws1.column_dimensions['A'].width = 22
ws1.column_dimensions['B'].width = 20
ws1.column_dimensions['C'].width = 70
ws1.column_dimensions['D'].width = 80

# Status fills
STATUS_FILLS = {
    "STRONG": PatternFill(start_color="C6EFCE", fill_type="solid"),
    "SOLID": PatternFill(start_color="E2F0D9", fill_type="solid"),
    "UNDERSELLING": PatternFill(start_color="FFEB9C", fill_type="solid"),
    "WEAK": PatternFill(start_color="FCD5B5", fill_type="solid"),
    "BLOCKER": PatternFill(start_color="FFC7CE", fill_type="solid"),
}

# Data rows: text wrap, top alignment
for row in range(3, n_rows+3):
    for col in range(1, 5):
        cell = ws1.cell(row=row, column=col)
        cell.alignment = Alignment(wrap_text=True, vertical='top')
```

## QA before delivery

Before presenting the file, run these checks:

1. **Open the file in openpyxl and scan for em-dashes.** No em-dash should remain in any cell.

```python
from openpyxl import load_workbook
wb = load_workbook(path)
em = 0
for ws in wb.worksheets:
    for row in ws.iter_rows():
        for cell in row:
            if cell.value and isinstance(cell.value, str) and ", " in cell.value:
                em += 1
print(f"em-dash cells: {em}")
```

Expect 0.

2. **Check the banner row contains specific named anchors.** If the banner says "based on past winners", that is too generic. It should say "anchored on The Signal ($121K SCF #42)" or similar.

3. **Check the rewrite cells (column D) are paste-ready English text.** Not in French. Not commentary. Actual text the client copies.

4. **Check the corpus comparables include the current dossier as row 1.** Sometimes the row gets cut. Verify.

5. **Confirm all four sheets exist** with the right titles.

```python
print(wb.sheetnames)
# Expect: ['Abstract Review' or 'Build Review', 'Checklist Pre-Submit', 'Comparables Corpus', 'Audit Integration List']
```

## Saving and presenting

Save to `outputs/`. Use `mcp__cowork__present_files` to surface the file to the user. Follow with a chat summary that includes the probability estimate, the top 3 to 5 fixes, and the `computer://` link to the file.
