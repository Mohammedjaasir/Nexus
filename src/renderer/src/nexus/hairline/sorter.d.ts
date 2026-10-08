export interface HairlineHost { stage: HTMLElement; svg: SVGSVGElement; read: { textContent: string | null } }
export interface SorterHandle { set(value: number): void; pick(n: number): void; destroy(): void }
export declare const sorter: {
  name: string;
  means: string;
  rules: number[];
  range: [number, number, number];
  mount(host: HairlineHost, value: number): SorterHandle;
};
