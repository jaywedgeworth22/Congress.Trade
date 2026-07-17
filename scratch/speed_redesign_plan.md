# Speed vs Data Providers: Redesign Plan

## Current Issues Identified
The user mentioned the section "is rotating through the information" and wants it simpler. While there is no actual JavaScript rotation/carousel, the current layout can feel visually overwhelming and disjointed (creating a "head-spinning" or noisy effect) because:
1. **Hero Cards are dense**: Each provider gets a hero card with 5 distinct lines of text (Title, Big Number, Label, Record, and N-count) with varying font sizes and colors. This makes the eye jump around.
2. **Race Lanes are complex**: The visualization includes a rail, span, p90 tick, us-dot, them-dot, plus numeric values. 
3. **Redundancy**: The same information (matches, leads) is repeated in the hero cards, race lanes, and the table.

## Proposed Redesign Strategy

We will keep all three sections (Heroes, Race Lanes, Table) but redesign them to be **clean, static, and elegant**, eliminating visual clutter.

### 1. Refined Hero Cards
We will condense the 5 lines of text into a much cleaner layout.
**HTML Changes in `renderSpeedProof()`**:
Instead of:
```html
<div class="speed-hero-card">
  <div class="speed-hero-title">Provider Name</div>
  <div class="speed-hero-num">1.5 hr</div>
  <div class="speed-hero-label">typical head start</div>
  <div class="speed-record">Ahead X · Behind Y · Ties Z</div>
  <div class="speed-n">n = M matched filings</div>
</div>
```
We will change it to a sleek, 2-part flex layout:
```html
<div class="speed-hero-card">
  <div class="speed-hero-top">
    <span class="speed-hero-title">Provider Name</span>
    <span class="speed-hero-badge">n=M</span>
  </div>
  <div class="speed-hero-main">
    <div class="speed-hero-num">1.5 hr</div>
    <div class="speed-hero-label">typical lead</div>
  </div>
  <div class="speed-hero-foot">
    <span class="win">W: X</span> • <span class="loss">L: Y</span> • <span class="tie">T: Z</span>
  </div>
</div>
```
**CSS Updates**:
- Make `.speed-hero-card` background a very subtle translucent layer.
- Use horizontal alignment for the footer stats so it reads as one clean line.

### 2. Streamlined Race Lanes
We will simplify the "race track" to look more like a polished data-viz bar chart.
**HTML/JS Changes**:
- Simplify the annotations and axis ticks so they are less noisy.
- Clean up the label formatting. The text above the track (`race-top`) will just be the Provider name and the primary metric.
- The `race-strip` will have softer colors. We will remove the prominent borders/shadows on the dots and make it a clean filled bar from 0 to the median lead, with a subtle marker for p90.

**CSS Updates for Race Lanes**:
- `.race-lane`: Reduce bottom margin slightly, clean up typography.
- `.race-dot`: Make them solid, elegant points rather than large ringed dots.
- `.race-span`: Slightly thicker and rounded for a modern look.

### 3. Tidy Table
The table is already inside a `<details>` block, which is good. We will keep it but ensure the typography matches the newly cleaned-up sections above.

### Summary of Execution
1. Modify `speed-hero-card` CSS in `app/src/ui/dashboardHtml.ts` (lines 767-772).
2. Modify `race-lane` CSS (lines 773-792).
3. Update the string template generation in `renderSpeedProof()` (around line 6574) for the hero cards.
4. Update the string template generation in `speedLaneHtml()` (around line 6531) to simplify the track layout.
5. Save changes and review the UI.

This approach will solve the "busy/rotating" feel by grounding the data in a static, predictable, and scannable grid.
