-- getproperty-api 0041 — landlord self-serve sign-up and portfolio units (B7.1, D-251, D-255). Requires
-- @collective/asset-core >= 0.5.0 (identity providers, building type `house`, external stubs, ownership source
-- `self_declared`).
--   * otp_purpose `landlord_signup`: the SMS code of a landlord signing up by phone (any phone, no account yet).
--   * ops.unit_detail gains what a landlord describes when adding a unit: its kind (condo unit, house, townhouse,
--     room), bedrooms, bathrooms, floor label and furnishing. Size and default rent stay on core.unit
--     (area_sqm, base_rent).
-- Deviation (schema-design §7.5 row 106).

ALTER TYPE platform.otp_purpose ADD VALUE IF NOT EXISTS 'landlord_signup';

CREATE TYPE ops.portfolio_unit_kind AS ENUM ('condo_unit', 'house', 'townhouse', 'room');
CREATE TYPE ops.furnishing AS ENUM ('unfurnished', 'partly_furnished', 'fully_furnished');

ALTER TABLE ops.unit_detail
  ADD COLUMN kind        ops.portfolio_unit_kind,
  ADD COLUMN bedrooms    smallint,
  ADD COLUMN bathrooms   smallint,
  ADD COLUMN floor_label text,
  ADD COLUMN furnishing  ops.furnishing,
  ADD CONSTRAINT unit_detail_rooms_check CHECK ((bedrooms IS NULL OR bedrooms BETWEEN 0 AND 50)
                                               AND (bathrooms IS NULL OR bathrooms BETWEEN 0 AND 50)),
  ADD CONSTRAINT unit_detail_floor_label_check CHECK (floor_label IS NULL OR length(floor_label) <= 20);
COMMENT ON COLUMN ops.unit_detail.kind IS 'What the landlord rents out (D-251): condo unit, house, townhouse or room; null for units of apartment buildings.';
