-- Nasal sprayer support: a delivery device graduated in "sprays" carries a fixed
-- volume per actuation (mL). Additive + nullable — existing syringes are untouched.
ALTER TABLE "Syringe" ADD COLUMN "mlPerSpray" DECIMAL;
