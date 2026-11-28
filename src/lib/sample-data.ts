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
    url: '/samples/duty.webp',
    width: 600,
    height: 750,
    tags: [
      { id: 'sample-duty-char', label: 'character', box: null },
      { id: 'sample-duty-hatch', label: 'hatching', box: [30, 340, 360, 220] },
      { id: 'sample-duty-obj', label: 'object', box: [390, 100, 170, 620] },
      { id: 'sample-duty-hand-l', label: 'hands', box: [125, 300, 75, 80] },
      { id: 'sample-duty-hand-r', label: 'hands', box: [430, 185, 80, 65] },
      { id: 'sample-duty-tex', label: 'texture', box: [0, 560, 260, 185] },
    ],
  },
  {
    id: 'sample-dance-chaos',
    name: 'dance_chaos.webp',
    url: '/samples/dance_chaos.webp',
    width: 600,
    height: 741,
    tags: [
      { id: 'sample-dance-char', label: 'character', box: null },
      { id: 'sample-dance-face', label: 'face', box: [220, 220, 95, 95] },
      { id: 'sample-dance-hand-r', label: 'hands', box: [380, 185, 130, 110] },
      { id: 'sample-dance-hand-l', label: 'hands', box: [95, 190, 65, 70] },
      { id: 'sample-dance-obj', label: 'object', box: [145, 390, 65, 65] },
    ],
  },
  {
    id: 'sample-child-top',
    name: 'child_top.webp',
    url: '/samples/child_top.webp',
    width: 600,
    height: 750,
    tags: [
      { id: 'sample-child-char', label: 'character', box: null },
      { id: 'sample-child-face', label: 'face', box: [220, 110, 155, 135] },
      { id: 'sample-child-hand-c', label: 'hands', box: [280, 455, 95, 115] },
      { id: 'sample-child-hand-r', label: 'hands', box: [420, 140, 95, 95] },
      { id: 'sample-child-obj', label: 'object', box: [430, 450, 155, 120] },
      { id: 'sample-child-hatch', label: 'hatching', box: [200, 55, 175, 110] },
    ],
  },
  {
    id: 'sample-machina',
    name: 'machina.webp',
    url: '/samples/machina.webp',
    width: 600,
    height: 750,
    tags: [
      { id: 'sample-machina-char', label: 'character', box: null },
      { id: 'sample-machina-face', label: 'face', box: [200, 145, 225, 175] },
      { id: 'sample-machina-obj', label: 'object', box: [5, 585, 140, 155] },
      { id: 'sample-machina-hatch', label: 'hatching', box: [185, 390, 275, 230] },
      { id: 'sample-machina-tex', label: 'texture', box: [0, 0, 600, 185] },
    ],
  },
]
