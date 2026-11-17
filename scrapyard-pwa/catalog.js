'use strict';

// Raw materials bought at the weighbridge (Module A).
const MATERIALS = [
  { id: 'copper-wire', name: 'Copper Wire', color: '#d9824f' },
  { id: 'aluminum-cable', name: 'Aluminum Cable', color: '#9fb8cf' },
  { id: 'brass', name: 'Brass', color: '#e0be4a' },
  { id: 'stainless-steel', name: 'Stainless Steel', color: '#b4bcc6' },
  { id: 'copper-pipes', name: 'Copper Pipes', color: '#c46d3d' },
  { id: 'kopa-pipes', name: 'Kopa Pipes', color: '#6fb08a' },
  { id: 'kopa-tanks', name: 'Kopa Tanks', color: '#58a07a' },
  { id: 'electric-motors', name: 'Electric Motors', color: '#9a86c8' },
  { id: 'transformers', name: 'Transformers', color: '#c486a0' },
  { id: 'radiators', name: 'Radiators', color: '#6fb0c4' },
  { id: 'mixed-metals', name: 'Mixed Metals', color: '#9aa3ad' },
];

// Finished, processed products that can be dispatched (Module B).
const PRODUCTS = [
  { id: 'copper-granules', name: 'Copper Granules', color: '#d9824f' },
  { id: 'aluminum-bars', name: 'Processed Aluminum Bars', color: '#9fb8cf' },
  { id: 'brass-ingots', name: 'Brass Ingots', color: '#e0be4a' },
  { id: 'recycled-copper-pipes', name: 'Recycled Copper Pipes', color: '#c46d3d' },
  { id: 'recycled-kopa-pipes', name: 'Recycled Kopa Pipes', color: '#6fb08a' },
  { id: 'recycled-kopa-tanks', name: 'Recycled Kopa Tanks', color: '#58a07a' },
  { id: 'electric-motor-scrap', name: 'Electric Motor Scrap', color: '#9a86c8' },
  { id: 'transformer-scrap', name: 'Transformer Scrap', color: '#c486a0' },
  { id: 'radiator-scrap', name: 'Radiator Scrap', color: '#6fb0c4' },
  { id: 'mixed-metal-scrap', name: 'Mixed Metal Scrap', color: '#9aa3ad' },
];

// Suggested output product when processing a raw material (admin can change it).
const DEFAULT_PRODUCT = {
  'copper-wire': 'copper-granules',
  'aluminum-cable': 'aluminum-bars',
  'brass': 'brass-ingots',
  'stainless-steel': 'mixed-metal-scrap',
  'copper-pipes': 'recycled-copper-pipes',
  'kopa-pipes': 'recycled-kopa-pipes',
  'kopa-tanks': 'recycled-kopa-tanks',
  'electric-motors': 'electric-motor-scrap',
  'transformers': 'transformer-scrap',
  'radiators': 'radiator-scrap',
  'mixed-metals': 'mixed-metal-scrap',
};

module.exports = { MATERIALS, PRODUCTS, DEFAULT_PRODUCT };
