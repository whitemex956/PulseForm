import type { World } from '../world';
import { LiquidForm } from './liquid';
import { ElectricEnergy } from './electric';
import { CosmicDreams } from './cosmic';
import { LaserDimension } from './laser';
import { ParticleUniverse } from './particles';
import { FestivalMode } from './festival';

export interface WorldInfo {
  id: string;
  name: string;
  tagline: string;
  /** gradient for the selector swatch */
  swatch: string;
  create: () => World;
}

/** Every visual world, all driven by the same VisualState interface. */
export const WORLDS: WorldInfo[] = [
  { id: 'liquid', name: 'Liquid Form', tagline: 'Iridescent chrome sculpture', swatch: 'conic-gradient(from 200deg, #2f6bff, #8a3dff, #ff3dd6, #ff8a3d, #2f6bff)', create: () => new LiquidForm() },
  { id: 'electric', name: 'Electric Energy', tagline: 'Plasma core, trails and lightning', swatch: 'radial-gradient(circle, #fff 0 12%, #4f8bff 30%, #1a1060 70%)', create: () => new ElectricEnergy() },
  { id: 'cosmic', name: 'Cosmic Dreams', tagline: 'Nebula clouds and slow celestial drift', swatch: 'radial-gradient(circle at 40% 40%, #ffd9a8 0 8%, #8a3dff 35%, #0b1a4a 75%)', create: () => new CosmicDreams() },
  { id: 'laser', name: 'Laser Dimension', tagline: 'Tunnels, beams and light architecture', swatch: 'repeating-conic-gradient(#ff3dd6 0 6deg, #06061a 6deg 30deg)', create: () => new LaserDimension() },
  { id: 'particles', name: 'Particle Universe', tagline: 'Thousands of particles forming shapes', swatch: 'radial-gradient(circle, #fff 0 2px, transparent 3px) 0 0/8px 8px, #2a1a6a', create: () => new ParticleUniverse() },
  { id: 'festival', name: 'Festival Mode', tagline: 'Stage lights, lasers and big drops', swatch: 'linear-gradient(180deg, #ff3dd6, #2f6bff 60%, #06061a)', create: () => new FestivalMode() },
];

export const worldName = (id: string) => WORLDS.find((w) => w.id === id)?.name ?? 'Liquid Form';
