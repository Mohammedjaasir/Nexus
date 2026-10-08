/**
 * Sorter: a pigeonhole rack of eight cubbies, one per Nexus workspace, each
 * holding a folded note. The cubby under the pointer takes the note: its slip
 * slides out and lifts, and the others draw theirs back in, staggered outwards
 * by distance on the rack. Each cubby's workspace is a dot code under its
 * opening. The slider is the stagger, in ms.
 *
 * App copy of hairline/sorter.js (made with the hairline-create skill), as a
 * module, with pick() added to the handle so the Welcome page can route it.
 */
import { HL } from "./kernel.js";

const {
  Cam, clamp, facing, fit, open, poly, prism, proj, put, rings, rrect, run, seg,
  tdone, tset, tval, tween, disposer, mk, place, pointer, reflect, register, solid,
} = HL;

const NAMES = ["SDE", "ML", "DL", "Data", "Research", "QA", "UI/UX", "DevOps"];
const COLS = 4, CW = 26, CH = 22, WALL = 5, DIV = 4, SHELF = 4, D = 24, DEEP = 9;
const X1 = WALL * 2 + COLS * CW + (COLS - 1) * DIV, ZT = WALL * 2 + CH * 2 + SHELF;
const REST = [9, 16, 5, 12, 13, 4, 10, 7], MARK = 1, OUT = 34, BACK = 1, LIFT = 9, IN = 5, INSET = 7;

/** Cubby i: its opening on the front face, in world x and z. Top row first. */
function cell(i) {
  const c = i % COLS, r = Math.floor(i / COLS);
  const x0 = WALL + c * (CW + DIV), z0 = r === 0 ? WALL + CH + SHELF : WALL;
  return { c, r, x0, x1: x0 + CW, z0, z1: z0 + CH };
}

function mount({ stage, svg, read }, value) {
  const bag = disposer();
  let stag = value;

  // fitted with every slip pulled all the way out, and the reflection under the rack
  const C = Cam(45, 0.5, 2.0);
  fit(C, [[0, 0, 0], [X1, 0, 0], [0, D + OUT, 0], [X1, D + OUT, -10], [0, 0, ZT], [X1, 0, ZT], [0, D, ZT]], 200, 166);
  const P = proj(C), front = facing(C);
  const onFace = (u, v) => P(u, D, v);

  const g = mk("g", {}, svg);
  const [outer, inner] = rings(0, 0, X1, D, 4, 1.6);
  reflect(svg, g, P, front, outer, 0, 14);
  put(solid(g), prism(P, front, outer, inner, 0, ZT));

  // the openings, each with the seams of its recess: floor to wall, then the back corner
  const cells = [];
  for (let i = 0; i < NAMES.length; i++) {
    const k = cell(i);
    mk("path", { d: poly(rrect(k.x0, k.z0, k.x1, k.z1, 2.5, 4).map((q) => onFace(q.u, q.v))), class: "nf" }, g);
    const bk = D - DEEP, up = k.z0 + CH - DEEP * 0.82;
    const seams = open([P(k.x0, D, k.z0), P(k.x0, bk, k.z0), P(k.x1 - DEEP, bk, k.z0)]) + seg(P(k.x0, bk, k.z0), P(k.x0, bk, up));
    mk("path", { d: seams, class: "nf lo" }, g);
    // the workspace's number, as one medium dot in a 4 × 2 grid on the shelf below the opening
    const mid = (k.x0 + k.x1) / 2;
    for (let j = 0; j < 8; j++) {
      const dot = mk("circle", { r: 0.9, class: "dot " + (j === i ? "m" : "off") }, g);
      place(dot, onFace(mid + ((j % 4) - 1.5) * 3.4, k.z0 - 1.3 - Math.floor(j / 4) * 1.5));
    }
    cells.push(k);
  }

  // the slips, painted over the face they stand out of
  const slips = cells.map((k, i) => {
    const grp = mk("g", {}, g);
    const edge = mk("path", { class: "nf lo" }, grp), top = mk("path", { class: "sil" + (i === MARK ? " hi" : "") }, grp);
    const fold = mk("path", { class: "nf lo" }, grp);
    return { k, edge, top, fold, out: tween(REST[i]), z: tween(0), last: "" };
  });

  function draw(s, out, lift) {
    const key = out.toFixed(2) + "," + lift.toFixed(2);
    if (key === s.last) return;
    s.last = key;
    const { x0, x1, z0 } = s.k, zs = z0 + 0.8 + lift;
    const at = (q, dz) => P(q.u, q.v, zs + dz);
    const ring = rrect(x0 + INSET, D - IN, x1 - INSET, D + out, 1.6, 3);
    s.top.setAttribute("d", poly(ring.map((q) => at(q, 0))));
    s.edge.setAttribute("d", open(run(ring, front).map((q) => at(q, -1))));
    const fy = D + out * 0.55;
    s.fold.setAttribute("d", out > 6 ? seg(at({ u: x0 + INSET + 1.5, v: fy }, 0), at({ u: x1 - INSET - 1.5, v: fy }, 0)) : "");
  }

  const B = register(stage, (_dt, now) => {
    let moving = false;
    slips.forEach((s) => { draw(s, tval(s.out, now), tval(s.z, now)); if (!tdone(s.out, now) || !tdone(s.z, now)) moving = true; });
    return moving;
  });
  bag.add(B.unregister);

  // hit test: the pointer read on the plane of the front face, which never moves
  const o = onFace(0, 0), eu = onFace(1, 0), ev = onFace(0, 1);
  const a = [eu[0] - o[0], eu[1] - o[1]], b = [ev[0] - o[0], ev[1] - o[1]], det = a[0] * b[1] - a[1] * b[0];
  function hit([x, y]) {
    const qx = x - o[0], qy = y - o[1];
    const u = (qx * b[1] - qy * b[0]) / det, v = (a[0] * qy - a[1] * qx) / det;
    if (u < WALL - 3 || u > X1 - WALL + 3 || v < WALL - 3 || v > ZT - WALL + 3) return -1;
    const c = clamp(Math.floor((u - WALL + DIV / 2) / (CW + DIV)), 0, COLS - 1);
    return (v >= WALL + CH + SHELF / 2 ? 0 : 1) * COLS + c;
  }

  let act = -1;
  /** Sends the note to cubby n (-1 puts every slip back). The stagger spreads out over the rack from n, or the one let go. */
  function setActive(n) {
    if (n === act) return;
    const now = performance.now(), from = cells[n >= 0 ? n : act];
    act = n;
    slips.forEach((s, i) => {
      const dist = Math.abs(s.k.c - from.c) + Math.abs(s.k.r - from.r);
      const out = n < 0 ? REST[i] : i === n ? OUT : BACK;
      tset(s.out, out, now, dist * stag); tset(s.z, i === n ? LIFT : 0, now, dist * stag);
      s.top.classList.toggle("hi", n < 0 ? i === MARK : i === n);
    });
    read.textContent = n < 0 ? "rest" : NAMES[n];
    B.wake();
  }

  read.textContent = "rest";
  bag.add(pointer(stage, { move: (p) => setActive(hit(p)), leave: () => setActive(-1) }));
  bag.add(() => svg.replaceChildren());

  return {
    set: (v) => { stag = v; },
    /** Sends the note to cubby n (-1 for rest), as the pointer would: lets a page route it. */
    pick: (n) => setActive(n),
    destroy: bag.dispose,
  };
}

export const sorter = {
  name: "sorter",
  means: "Eight pigeonholes, one per workspace: the one under the pointer takes the note, and the rest draw theirs back in turn.",
  rules: [1, 2, 5, 10],
  range: [0, 45, 90],
  mount,
};
