// Hover help for form fields. Rest the mouse on a field (its label or its
// control) for about a second and a short explanation appears; any key press,
// click or scroll hides it, and it stays hidden for that field until the
// mouse leaves and comes back.
//
// Texts are looked up by the field's label, in the nearest table attached to
// an ancestor element (`el.tips = {...}`) — a dialog gets its table through
// openModal({ tips }), the Settings view sets its own. Per-form tables let
// labels like "Name" or "Notes" mean different things in different forms.
//
// Only on devices with a real mouse: on touch screens a tap fires hover
// events, which would pop tooltips up mid-tap.

const DELAY_MS = 1000;

export function initTips() {
  if (!matchMedia('(hover: hover) and (pointer: fine)').matches) return;
  const tip = document.createElement('div');
  tip.id = 'tooltip';
  tip.setAttribute('role', 'tooltip');
  // A popover sits in the top layer, above an open modal <dialog>.
  const usePopover = typeof tip.showPopover === 'function';
  if (usePopover) tip.popover = 'manual';
  tip.hidden = !usePopover;
  document.body.append(tip);

  let timer = null;
  let current = null; // the .field the pointer is over
  let shownFor = null;
  let suppressed = null; // field the user typed in: no tooltip until re-entered

  const hide = () => {
    clearTimeout(timer);
    timer = null;
    if (!shownFor) return;
    shownFor = null;
    if (usePopover) { try { tip.hidePopover(); } catch { /* already hidden */ } } else tip.hidden = true;
  };

  function show(field, text) {
    tip.textContent = text;
    // Inside a dialog without popover support, live in the dialog's top layer.
    if (!usePopover) (field.closest('dialog') || document.body).append(tip);
    if (usePopover) tip.showPopover(); else tip.hidden = false;
    const r = field.getBoundingClientRect();
    const t = tip.getBoundingClientRect();
    const left = Math.max(8, Math.min(r.left, innerWidth - t.width - 8));
    const above = r.top - t.height - 6;
    tip.style.left = `${left}px`;
    tip.style.top = `${above >= 8 ? above : Math.min(r.bottom + 6, innerHeight - t.height - 8)}px`;
    shownFor = field;
  }

  document.addEventListener('mouseover', (e) => {
    const field = e.target.closest?.('.field');
    if (field === current) return;
    current = field;
    hide();
    if (field !== suppressed) suppressed = null;
    if (!field || field === suppressed) return;
    const text = tipFor(field);
    if (!text) return;
    timer = setTimeout(() => { if (current === field && suppressed !== field) show(field, text); }, DELAY_MS);
  });
  document.addEventListener('mouseout', (e) => {
    if (current && !current.contains(e.relatedTarget)) { current = null; suppressed = null; hide(); }
  });
  // Typing (or any key), clicking, scrolling: get out of the way.
  const dismiss = () => { if (current) suppressed = current; hide(); };
  document.addEventListener('keydown', dismiss, true);
  document.addEventListener('input', dismiss, true);
  document.addEventListener('pointerdown', dismiss, true);
  document.addEventListener('wheel', hide, { capture: true, passive: true });
  document.addEventListener('scroll', hide, true);
  window.addEventListener('blur', hide);
  document.addEventListener('close', hide, true); // a dialog closed
}

function labelOf(field) {
  const l = field.querySelector(':scope > .field-label, :scope > label');
  return l ? l.textContent.trim() : '';
}

export function tipFor(field) {
  const label = labelOf(field);
  if (!label) return '';
  for (let el = field; el; el = el.parentElement) {
    if (el.tips && el.tips[label]) return el.tips[label];
  }
  return '';
}

// ---------- help texts, one table per form ----------

export const PAINT_TIPS = {
  'Color name': 'The manufacturer’s name for the color, e.g. Agreeable Gray. Searchable.',
  'Color code': 'The code on the can or chip, e.g. SW 7029 — the surest way to buy an exact match again.',
  Brand: 'The paint manufacturer. Used by the Brand filter.',
  'Product line': 'The specific product, e.g. Duration or Regal Select. The same color in another line can look and wear differently.',
  Swatch: 'An approximate on-screen color for the card. Screens vary, so trust the code, not the swatch. Tick “No swatch” to leave it blank.',
  'Color family': 'Used by the Color family filter. “Auto” guesses from the swatch; pick one to override it.',
  Sheen: 'From flat (hides flaws, least washable) to high-gloss (toughest, shows flaws). Touch-ups only blend in the same sheen.',
  'Base type': 'Water-based (latex/acrylic) or oil-based (alkyd). Latex over oil needs a bonding primer first.',
  'Tint base': 'The base the store tinted, e.g. Base 2 or Deep — printed on the can label and needed to mix an exact match.',
  Coverage: 'How far it went, e.g. 1 gal ≈ 350 sq ft for 2 coats. Handy when buying for touch-ups.',
  'Rooms & areas': 'Where this color is used: room, area (walls, trim…), number of coats and the date painted. One row per place.',
  'Photos (swatches, can labels)': 'Photos of the chip or the can label — the label has the formula the store can re-mix.',
  'Purchased / leftovers': 'Where and when you bought it, and how much is left and where it’s stored.',
  Notes: 'Anything else: prep, primer, problems, touch-up tips.',
};

export const ROOM_TIPS = {
  Name: 'The room or space, e.g. Kitchen, Garage or Back deck.',
  Property: 'Only needed if you track more than one property (house, cabin…). Rooms and panels are grouped by it.',
  'Floor / area': 'Floor or zone, e.g. Basement, Upstairs or Exterior.',
  Notes: 'Anything about this room.',
};

export const BREAKER_TIPS = {
  Panel: 'Which panel this breaker is in.',
  Slot: 'The top space it occupies. Odd numbers run down the left column, even numbers down the right.',
  Poles: '1-pole: one space (120 V). 2-pole: one breaker across two spaces with a single handle (240 V, e.g. dryer, range). 3-pole: three-phase panels.',
  Tandem: 'A half-width “twin” breaker: two circuits sharing one space, A on top and B below.',
  'Linked breakers': 'Tick if this breaker’s handle is tied to the single breaker directly below — two circuits that trip together, e.g. a shared-neutral circuit. For one breaker spanning both spaces, use 2-pole instead.',
  Amps: 'The number on the handle: 15, 20, 30…',
  Type: 'GFCI, AFCI and dual-function breakers have a test button. HACR is rated for heating and air-conditioning. Spare = installed but unused.',
  Label: 'What you’d write on the panel door, e.g. Kitchen counter outlets. Shown on the map and the printed legend.',
  Rooms: 'Rooms this circuit feeds. Used by the By room view and search.',
  'Fixtures & loads': 'What’s on the circuit. Pick from your fixture list or “+ New fixture…”, then pin each to one room if it’s only there; otherwise leave “all of this breaker’s rooms”.',
  'Wire gauge': 'Wire size, printed on the cable jacket. Typical copper: 14 AWG on 15 A, 12 AWG on 20 A, 10 AWG on 30 A.',
  'Wire type': 'Cable or conductor type, e.g. NM-B (Romex), MC or THHN in conduit — printed on the jacket.',
  'Feeds sub-panel': 'If this breaker supplies a sub-panel, pick it to link the two panels.',
  'Legend font scale': 'Makes this breaker’s text bigger or smaller on the printed legend only.',
  Notes: 'Anything else: what tripped it last time, surprises found on the circuit…',
};

export const FIXTURE_TIPS = {
  Name: 'What the load is, e.g. Pendant lights or Garbage disposal. Renaming it updates every breaker that uses it.',
  Room: 'The room this fixture is usually in. Adding it to a breaker starts it there — you can still change it per breaker. Leave empty for things in many rooms, like outlets.',
  Notes: 'Anything worth knowing: wattage, model, exactly where it is.',
};

export const PANEL_TIPS = {
  Name: 'What to call this panel, e.g. Main panel or Garage sub-panel.',
  Property: 'Only needed if you track more than one property.',
  Location: 'Where it is, so someone else can find it, e.g. Basement, north wall.',
  Kind: 'Main panel (where the power comes in) or a sub-panel fed from a breaker in another panel.',
  'Phase colors': 'How many hot legs to color: 2 for a normal 120/240 V home, 3 for three-phase, 1 to turn the colors off.',
  Colors: 'The color for each leg or phase, shown beside the slot numbers on the map and legend.',
  Spaces: 'Total breaker spaces in both columns — usually on the label inside the door.',
  'Main breaker (A)': 'The main breaker’s rating, e.g. 200.',
  Service: 'Supply voltage and type, e.g. 120/240 V split-phase.',
  Notes: 'Anything else about this panel.',
};

export const LEGEND_TIPS = {
  Paper: 'Page size to print or save as PDF. Pick Custom to type your own width and height.',
  Orientation: 'Portrait or landscape.',
  'Width (in)': 'Page width in inches (Custom paper only).',
  'Height (in)': 'Page height in inches (Custom paper only).',
  'Margin (in)': 'Blank border around the legend, in inches.',
  'Base font size': 'Text size for every label; each breaker’s own “Legend font scale” adjusts from here.',
  Title: 'Heading printed at the top of the legend.',
  // The options row of checkboxes; its first label is "Phase colors".
  'Phase colors': 'What each line shows: phase colors beside the slot numbers, amps and type, rooms, wire gauge. “Stretch” spreads the rows to fill the page height.',
};

export const ITEM_TIPS = {
  Name: 'What the item is, e.g. Espresso machine.',
  Brand: 'Manufacturer.',
  'Model number': 'From the rating plate or box — needed for parts, manuals and recalls.',
  'Serial number': 'Proves it’s yours for insurance and warranty claims.',
  'Acquisition date': 'When you got it. Warranty quick-fill buttons count from this date.',
  'Purchase cost ($)': 'What you paid. The list shows a running total for insurance.',
  Room: 'Which room it’s in.',
  'Location detail': 'Where exactly, e.g. top shelf of the hall closet.',
  Description: 'Anything that identifies it: size, color, condition, accessories.',
  'Warranty expires': 'When the warranty ends. A reminder appears under Maintenance 60 days ahead and in the calendar export. +1/2/3/5 yr count from the acquisition date.',
  'Warranty details': 'Provider, plan or registration number, claim phone — what you’ll need to make a claim.',
  'Pictures (item, receipt, serial plate)': 'Photos of the item, the receipt and the serial plate — the evidence an insurer will ask for.',
  'Manuals & documents': 'Links to online manuals or uploaded files (PDFs up to 10 MB). Linking the maker’s PDF uses less space than uploading.',
};

export const TASK_TIPS = {
  Task: 'What needs doing, e.g. Replace HVAC air filter.',
  Category: 'Groups tasks, e.g. HVAC or Plumbing. Used by the category filter.',
  Repeat: 'How often: every N days, weeks, months or years — or one time.',
  'Last done': 'When it was last done. The next due date counts from here.',
  'First due': 'When it’s first due — used until you log it the first time.',
  Room: 'Where the task happens.',
  'Inventory item': 'The appliance this is for. Its manuals then show on the task.',
  'Parts & supplies': 'Filter size, part numbers, supplies — so you buy the right thing.',
  Notes: 'How to do it, who to call, anything worth remembering.',
  Log: 'Every time this was done. Delete an entry with ✕.',
};

export const DONE_TIPS = {
  Date: 'When you did it. The next due date counts from here.',
  'Cost ($)': 'What it cost, if anything. History shows yearly totals.',
  Note: 'What you used or found, e.g. filter size, readings, who did it.',
};

export const SETTINGS_TIPS = {
  Owner: 'The GitHub user or organization that owns your private data repo.',
  Repo: 'The name of the private repo that holds your data, e.g. home-data.',
  Branch: 'Branch to read and write. Leave it as main unless you know otherwise.',
  'Folder in the repo': 'Where the app’s files go inside the repo: data by default, any folder, or / for the root.',
  'Personal access token': 'A fine-grained token with Contents read and write on the data repo only. It stays in this browser.',
  'Encryption password': 'Encrypts your data before it’s uploaded. There’s no recovery if you forget it.',
};
