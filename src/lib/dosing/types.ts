/**
 * Dosing engine types.
 *
 * SAFETY-CRITICAL MODULE. Canonical internal units:
 *   - mass   : micrograms (mcg)
 *   - volume : millilitres (mL)
 *   - concentration: mcg per mL
 *
 * All arithmetic uses decimal.js. Never use the native `number` type for a
 * value that participates in a dose calculation.
 */
import Decimal from "decimal.js";

/**
 * Unit a dose may be *entered* in. Distinct from a peptide's substance class.
 * `sprays` is nasal-only: a spray count converts to volume via the sprayer's
 * mL/spray, then to mass via the vial concentration (see canonicaliseDose).
 */
export type DoseUnit = "mcg" | "mg" | "ml" | "units" | "sprays";

/** How a peptide's strength is defined. IU substances never convert to/from mass. */
export type SubstanceClass = "mass" | "IU";

/** How a delivery device is graduated. `sprays` = a nasal sprayer/dropper. */
export type GraduationType = "units" | "ml" | "sprays";

/** A delivery device: a syringe/needle, or (graduationType "sprays") a nasal sprayer. */
export interface Syringe {
  name: string;
  graduationType: GraduationType;
  /** Units per mL. U-100 = 100. Only meaningful for unit-graduated syringes. */
  unitsPerMl: number;
  /** Total barrel capacity in mL (e.g. 0.3 / 0.5 / 1.0). */
  capacityMl: Decimal.Value;
  /** Total barrel capacity in units (e.g. 30 / 50 / 100). */
  capacityUnits: number;
  /** Smallest measurable mark, in the device's native scale (units / mL / sprays). */
  increment: Decimal.Value;
  /**
   * Volume delivered per actuation, in mL. ONLY meaningful (and required) for a
   * sprays-graduated device — the fixed mechanical property of the pump. mcg per
   * spray is derived at dose time from this × the vial concentration.
   */
  mlPerSpray?: Decimal.Value | null;
}

/** A vial's prepared state — the source of concentration for every dose. */
export interface Preparation {
  prepType: "reconstituted" | "premixed";
  /** Concentration in mcg/mL — computed for reconstituted, entered for premixed. */
  concentrationMcgPerMl: Decimal;
}

export interface DoseInput {
  value: Decimal.Value;
  unit: DoseUnit;
}

export type WarningSeverity = "warn" | "block";

export interface DosingWarning {
  code: string;
  severity: WarningSeverity;
  message: string;
}

export interface DrawResult {
  /** What the user asked for, canonicalised. */
  targetMassMcg: Decimal;
  targetVolumeMl: Decimal;
  /** Unrounded units (informational). */
  rawUnits: Decimal;
  /** Value to draw to, in the syringe's native scale. */
  markingValue: Decimal;
  markingScale: GraduationType;
  /** What is actually delivered after rounding to the syringe increment. */
  deliveredMassMcg: Decimal;
  deliveredVolumeMl: Decimal;
  /** deliveredMass − targetMass. Positive = slight overdose from rounding. */
  roundingErrorMcg: Decimal;
  warnings: DosingWarning[];
}
