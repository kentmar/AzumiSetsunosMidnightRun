import { TUNING, TUNING_DEFAULTS, type Tuning } from './tuning';

// Live feel-tuning panel (toggle: P). Sliders bind straight into TUNING; keys
// listed in VEHICLE_KEYS re-apply vehicle physics on change. Values persist to
// localStorage and can be copied out as JSON.

interface SliderDef {
  key: keyof Tuning;
  min: number;
  max: number;
  step: number;
  group: string;
}

const DEFS: SliderDef[] = [
  { key: 'mass', min: 600, max: 2600, step: 10, group: 'Vehicle' },
  { key: 'enginePower', min: 2000, max: 22000, step: 100, group: 'Vehicle' },
  { key: 'brakeForce', min: 5, max: 200, step: 1, group: 'Vehicle' },
  { key: 'maxSpeed', min: 25, max: 90, step: 1, group: 'Vehicle' },
  { key: 'awd', min: 0, max: 1, step: 1, group: 'Vehicle' },
  { key: 'suspStiffness', min: 8, max: 90, step: 0.5, group: 'Suspension' },
  { key: 'suspDampCompression', min: 0.5, max: 10, step: 0.1, group: 'Suspension' },
  { key: 'suspDampRelaxation', min: 0.5, max: 12, step: 0.1, group: 'Suspension' },
  { key: 'suspTravel', min: 0.05, max: 0.5, step: 0.01, group: 'Suspension' },
  { key: 'suspRest', min: 0.15, max: 0.55, step: 0.01, group: 'Suspension' },
  { key: 'comHeight', min: -0.6, max: 0.2, step: 0.01, group: 'Suspension' },
  { key: 'downforce', min: 0, max: 12, step: 0.1, group: 'Suspension' },
  { key: 'slopeForce', min: 0, max: 12, step: 0.1, group: 'Vehicle' },
  { key: 'frontGrip', min: 0.3, max: 2.2, step: 0.01, group: 'Grip' },
  { key: 'rearGrip', min: 0.3, max: 2.2, step: 0.01, group: 'Grip' },
  { key: 'handbrakeGripCut', min: 0.05, max: 0.8, step: 0.01, group: 'Grip' },
  { key: 'driftGripDrop', min: 0, max: 0.8, step: 0.01, group: 'Grip' },
  { key: 'steerSpeed', min: 1, max: 16, step: 0.1, group: 'Grip' },
  { key: 'steerMax', min: 0.2, max: 1.0, step: 0.01, group: 'Grip' },
  { key: 'steerSpeedDrop', min: 0, max: 0.06, step: 0.001, group: 'Grip' },
  { key: 'camDistance', min: 3, max: 14, step: 0.1, group: 'Camera' },
  { key: 'camHeight', min: 0.8, max: 6, step: 0.1, group: 'Camera' },
  { key: 'camFovBase', min: 45, max: 80, step: 1, group: 'Camera' },
  { key: 'camFovMax', min: 60, max: 110, step: 1, group: 'Camera' },
  { key: 'camLag', min: 1, max: 12, step: 0.1, group: 'Camera' },
  { key: 'camDriftTrail', min: 0, max: 1, step: 0.01, group: 'Camera' },
  { key: 'fpsCap', min: 0, max: 120, step: 1, group: 'Camera' },
  { key: 'crashDvGlance', min: 2, max: 10, step: 0.1, group: 'Crash' },
  { key: 'crashDvHard', min: 5, max: 24, step: 0.1, group: 'Crash' },
  { key: 'crashSlowmo', min: 0.05, max: 0.6, step: 0.01, group: 'Crash' },
  { key: 'crashSlowmoTime', min: 0.2, max: 2, step: 0.05, group: 'Crash' },
  { key: 'crashShake', min: 0, max: 3, step: 0.05, group: 'Crash' },
];

const VEHICLE_KEYS = new Set<keyof Tuning>([
  'mass', 'suspStiffness', 'suspDampCompression', 'suspDampRelaxation',
  'suspTravel', 'suspRest', 'comHeight', 'frontGrip', 'rearGrip',
]);

const LS_KEY = 'nightrun-tuning-v2';

export class Panel {
  private el: HTMLDivElement;
  private visible = false;
  private valueEls = new Map<string, HTMLSpanElement>();

  constructor(private onVehicleChange: () => void) {
    // restore persisted values
    try {
      const saved = JSON.parse(localStorage.getItem(LS_KEY) ?? '{}');
      for (const k of Object.keys(saved)) {
        if (k in TUNING) (TUNING as Record<string, number>)[k] = saved[k];
      }
    } catch { /* fresh start */ }

    this.el = document.createElement('div');
    this.el.style.cssText = `position:fixed;right:0;top:0;bottom:0;width:300px;z-index:50;
      background:rgba(8,6,12,0.92);border-left:1px solid rgba(255,184,77,0.3);
      color:#ddd;font:12px ui-monospace,Menlo,monospace;overflow-y:auto;padding:12px;
      box-sizing:border-box;display:none;`;
    document.body.appendChild(this.el);

    const title = document.createElement('div');
    title.style.cssText = 'font-size:14px;color:#ffb84d;letter-spacing:2px;margin-bottom:10px;';
    title.textContent = 'FEEL TUNING [P]';
    this.el.appendChild(title);

    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;gap:6px;margin-bottom:12px;';
    this.el.appendChild(btnRow);
    const mkBtn = (label: string, fn: () => void) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.style.cssText = `flex:1;background:#221a10;color:#ffb84d;border:1px solid #665533;
        padding:6px;cursor:pointer;font:11px ui-monospace,monospace;`;
      b.onclick = fn;
      btnRow.appendChild(b);
    };
    mkBtn('COPY JSON', () => {
      const json = JSON.stringify(TUNING, null, 2);
      navigator.clipboard?.writeText(json).catch(() => {});
      console.log('[tuning]', json);
    });
    mkBtn('RESET', () => {
      Object.assign(TUNING, TUNING_DEFAULTS);
      localStorage.removeItem(LS_KEY);
      this.refresh();
      this.onVehicleChange();
    });

    let lastGroup = '';
    for (const def of DEFS) {
      if (def.group !== lastGroup) {
        lastGroup = def.group;
        const g = document.createElement('div');
        g.style.cssText = 'color:#58e6ff;letter-spacing:2px;margin:12px 0 4px;font-size:11px;';
        g.textContent = def.group.toUpperCase();
        this.el.appendChild(g);
      }
      this.el.appendChild(this.makeSlider(def));
    }
  }

  private inputs = new Map<string, HTMLInputElement>();

  private makeSlider(def: SliderDef): HTMLDivElement {
    const row = document.createElement('div');
    row.style.cssText = 'margin-bottom:6px;';
    const label = document.createElement('div');
    label.style.cssText = 'display:flex;justify-content:space-between;';
    const name = document.createElement('span');
    name.textContent = def.key;
    const val = document.createElement('span');
    val.style.color = '#ffb84d';
    val.textContent = String(TUNING[def.key]);
    label.appendChild(name);
    label.appendChild(val);
    row.appendChild(label);
    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(def.min);
    input.max = String(def.max);
    input.step = String(def.step);
    input.value = String(TUNING[def.key]);
    input.style.cssText = 'width:100%;accent-color:#ffb84d;';
    input.oninput = () => {
      (TUNING as Record<string, number>)[def.key] = parseFloat(input.value);
      val.textContent = input.value;
      localStorage.setItem(LS_KEY, JSON.stringify(TUNING));
      if (VEHICLE_KEYS.has(def.key)) this.onVehicleChange();
    };
    row.appendChild(input);
    this.valueEls.set(def.key, val);
    this.inputs.set(def.key, input);
    return row;
  }

  private refresh() {
    for (const [k, input] of this.inputs) {
      input.value = String(TUNING[k as keyof Tuning]);
      this.valueEls.get(k)!.textContent = input.value;
    }
  }

  toggle() {
    this.visible = !this.visible;
    this.el.style.display = this.visible ? 'block' : 'none';
  }
}
