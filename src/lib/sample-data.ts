export type SampleRect = [number, number, number, number]

export interface SampleTagSpec {
  id: string
  label: string
  box: SampleRect | null
}

export interface SampleDrawingSpec {
  id: string
  name: string
  url: string
  width: number
  height: number
  tags: SampleTagSpec[]
}

export const SAMPLE_FOLDER_ID = 'sample-folder-not'
export const SAMPLE_FOLDER_NAME = 'Samples'
export const SAMPLE_QUICK_TAGS = ['face', 'hands', 'hatching', 'object'] as const

/**
 * Curated sample ink artworks by NOT with pre-cropped tag regions so first-time
 * visitors can immediately experience tag search and cropped reference sheets.
 */
export const SAMPLE_DRAWINGS: readonly SampleDrawingSpec[] = [
  {
    id: 'sample-duty',
    name: 'duty.webp',
    url: '/samples/duty.webp?v=2',
    width: 1440,
    height: 1800,
    tags: [
      { id: 'sample-duty-char', label: 'character', box: null },
      { id: 'sample-duty-hatch', label: 'hatching', box: [72, 816, 864, 528] },
      { id: 'sample-duty-obj', label: 'object', box: [936, 240, 408, 1488] },
      { id: 'sample-duty-hand-l', label: 'hands', box: [300, 720, 180, 192] },
      { id: 'sample-duty-hand-r', label: 'hands', box: [1032, 444, 192, 156] },
      { id: 'sample-duty-tex', label: 'texture', box: [0, 1344, 624, 444] },
    ],
  },
  {
    id: 'sample-dance-chaos',
    name: 'dance_chaos.webp',
    url: '/samples/dance_chaos.webp?v=2',
    width: 1088,
    height: 1344,
    tags: [
      { id: 'sample-dance-char', label: 'character', box: null },
      { id: 'sample-dance-face', label: 'face', box: [399, 399, 172, 172] },
      { id: 'sample-dance-hand-r', label: 'hands', box: [689, 336, 236, 200] },
      { id: 'sample-dance-hand-l', label: 'hands', box: [172, 345, 118, 127] },
      { id: 'sample-dance-obj', label: 'object', box: [263, 707, 118, 118] },
    ],
  },
  {
    id: 'sample-child-top',
    name: 'child_top.webp',
    url: '/samples/child_top.webp?v=2',
    width: 1080,
    height: 1350,
    tags: [
      { id: 'sample-child-char', label: 'character', box: null },
      { id: 'sample-child-face', label: 'face', box: [396, 198, 279, 243] },
      { id: 'sample-child-hand-c', label: 'hands', box: [504, 819, 171, 207] },
      { id: 'sample-child-hand-r', label: 'hands', box: [756, 252, 171, 171] },
      { id: 'sample-child-obj', label: 'object', box: [774, 810, 279, 216] },
      { id: 'sample-child-hatch', label: 'hatching', box: [360, 99, 315, 198] },
    ],
  },
  {
    id: 'sample-machina',
    name: 'machina.webp',
    url: '/samples/machina.webp?v=2',
    width: 1080,
    height: 1350,
    tags: [
      { id: 'sample-machina-char', label: 'character', box: null },
      { id: 'sample-machina-face', label: 'face', box: [360, 261, 405, 315] },
      { id: 'sample-machina-obj', label: 'object', box: [9, 1053, 252, 279] },
      { id: 'sample-machina-hatch', label: 'hatching', box: [333, 702, 495, 414] },
      { id: 'sample-machina-tex', label: 'texture', box: [0, 0, 1080, 333] },
    ],
  },
]
