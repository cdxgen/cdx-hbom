/**
 * Cable diagnostics for charging speed and data-rate bottlenecks.
 *
 * A USB-C connection is only as capable as its weakest participant. These
 * helpers compare the advertised capability of the charger, the cable, the
 * host port, and the connected device, then name the component that is holding
 * the connection back. They are pure functions so they can be exercised against
 * captured values without touching hardware.
 */

// Charging headroom below which a shortfall is treated as normal rather than a
// fault. Batteries taper as they fill, so a small gap is expected.
const CHARGING_TOLERANCE_WATTS = 5;
const CHARGING_TOLERANCE_RATIO = 0.1;

// Data rates fall into well-separated tiers, so two figures within this ratio
// of each other are treated as the same tier rather than a real difference.
const SAME_TIER_RATIO = 0.1;

// A negotiated contract or sink request below this fraction of the reference
// wattage is treated as a genuine step down rather than headroom.
const CONTRACT_SHORTFALL_RATIO = 0.8;

// USB-C cables without an electronic marker are limited to 3A by the
// specification. A request pinned within this band of 3A, against a supply
// that offers more, is the signature of such a cable.
const THREE_AMP_LOW_MILLIAMP = 2900;
const THREE_AMP_HIGH_MILLIAMP = 3100;

/**
 * @typedef {object} ChargingInputs
 * @property {number} [chargerMaxWatts] Highest wattage the charger advertises.
 * @property {number} [cableMaxWatts] Highest wattage the cable is rated for.
 * @property {number} [negotiatedWatts] Wattage of the active power contract,
 *   used as a generic figure when finer inputs are unavailable.
 * @property {number} [activeWatts] Wattage of the active source PDO.
 * @property {number} [activeCurrentMilliamp] Current the active source PDO offers.
 * @property {number} [requestedWatts] Wattage the sink is actually requesting
 *   (a ceiling it asked for, never a measured flow).
 * @property {number} [requestedMilliamp] Current the sink is requesting.
 * @property {boolean} [cableCurrentRatingVisible] Whether a cable e-marker
 *   current rating was observed.
 * @property {boolean} [connectionActive] Whether the port is actively linked.
 */

/**
 * Identify what is limiting charging speed on a USB-C port.
 *
 * The order of suspicion matters. A cable rated below the charger is the only
 * directly actionable fault, so it is considered first. A request pinned at 3A
 * with no visible e-marker points at an unmarked cable, which is also
 * actionable. A low contract or a sink asking for less than its contract
 * allows are both benign and reported without a warning, since they are
 * usually the device's own battery or thermal policy.
 *
 * Every figure here is an advertised capability or a requested ceiling. None
 * of them is a measured power flow, and the verdicts are worded to reflect
 * that.
 *
 * @param {ChargingInputs} inputs Capability figures.
 * @returns {{
 *   bottleneck: string,
 *   isWarning: boolean,
 *   verdict: string
 * }} Diagnosis.
 */
export function chargingDiagnostic(inputs) {
  const {
    chargerMaxWatts,
    cableMaxWatts,
    negotiatedWatts,
    activeWatts,
    activeCurrentMilliamp,
    requestedWatts,
    requestedMilliamp,
    cableCurrentRatingVisible,
  } = inputs;

  if (inputs.connectionActive === false) {
    return {
      bottleneck: "disconnected",
      isWarning: false,
      verdict: "No active power contract on this port",
    };
  }

  if (
    chargerMaxWatts !== undefined &&
    cableMaxWatts !== undefined &&
    cableMaxWatts + 1 < chargerMaxWatts
  ) {
    return {
      bottleneck: "cable-limit",
      isWarning: true,
      verdict: `Cable rated for ${cableMaxWatts}W is limiting a ${chargerMaxWatts}W charger`,
    };
  }

  // A supply offering more than 3A, a sink drawing right at 3A, and no visible
  // cable e-marker together point at an unmarked cable, which the spec caps at
  // 3A. Phrase it as "not visible" rather than "missing": some controllers
  // simply do not populate the cable node.
  if (
    cableCurrentRatingVisible !== true &&
    activeCurrentMilliamp !== undefined &&
    activeCurrentMilliamp > THREE_AMP_HIGH_MILLIAMP &&
    requestedMilliamp !== undefined &&
    requestedMilliamp >= THREE_AMP_LOW_MILLIAMP &&
    requestedMilliamp <= THREE_AMP_HIGH_MILLIAMP
  ) {
    return {
      bottleneck: "cable-no-emarker",
      isWarning: true,
      verdict: `Supply offers ${(activeCurrentMilliamp / 1000).toFixed(1)}A but the draw is capped near 3A and no cable e-marker is visible, which limits an unmarked cable to 3A`,
    };
  }

  // The active contract itself is well below what the charger can deliver.
  // Usually the device's own policy rather than a cable or charger fault.
  if (
    chargerMaxWatts !== undefined &&
    activeWatts !== undefined &&
    activeWatts > 0 &&
    activeWatts < chargerMaxWatts * CONTRACT_SHORTFALL_RATIO
  ) {
    return {
      bottleneck: "device-limit",
      isWarning: false,
      verdict: `Contract limited to ${round(activeWatts)}W of the ${round(chargerMaxWatts)}W the charger offers, often the device's own battery or thermal policy`,
    };
  }

  // The contract is healthy but the sink is requesting much less than it
  // allows, for example a laptop with an 80 percent battery charge limit.
  const contractReference = activeWatts ?? minimumDefined(chargerMaxWatts, cableMaxWatts);
  if (
    requestedWatts !== undefined &&
    requestedWatts > 0 &&
    contractReference !== undefined &&
    requestedWatts < contractReference * CONTRACT_SHORTFALL_RATIO
  ) {
    return {
      bottleneck: "sink-limit",
      isWarning: false,
      verdict: `Requesting up to ${round(requestedWatts)}W of the ${round(contractReference)}W available, often a battery charge limit or thermal policy`,
    };
  }

  const ceiling = minimumDefined(chargerMaxWatts, cableMaxWatts);

  if (negotiatedWatts !== undefined) {
    if (ceiling !== undefined && meaningfullyBelow(negotiatedWatts, ceiling)) {
      return {
        bottleneck: "host-limit",
        isWarning: false,
        verdict: `Drawing ${negotiatedWatts}W, below the ${ceiling}W available (battery may be near full)`,
      };
    }

    return {
      bottleneck: "fine",
      isWarning: false,
      verdict: `Charging at up to ${negotiatedWatts}W`,
    };
  }

  if (activeWatts !== undefined && activeWatts > 0) {
    return {
      bottleneck: "fine",
      isWarning: false,
      verdict: `Charging at up to ${round(activeWatts)}W`,
    };
  }

  // No power contract was reported, which is common because sysfs does not
  // expose the negotiated request. The charger and cable still bound how much
  // power can flow, so report that ceiling rather than giving up.
  if (ceiling !== undefined) {
    return {
      bottleneck: "fine",
      isWarning: false,
      verdict: `Charger and cable support up to ${ceiling}W`,
    };
  }

  return {
    bottleneck: "unknown",
    isWarning: false,
    verdict: "Charging capability could not be determined",
  };
}

/**
 * Round a wattage to a whole number for display.
 *
 * @param {number} value Wattage.
 * @returns {number} Rounded wattage.
 */
function round(value) {
  return Math.round(value);
}

/**
 * @typedef {object} DataLinkInputs
 * @property {number} [hostGbps] Data rate the host port supports.
 * @property {number} [cableGbps] Data rate the cable advertises.
 * @property {number} [deviceGbps] Data rate the connected device supports.
 * @property {number} [negotiatedGbps] Data rate actually negotiated.
 */

/**
 * Identify what is limiting the data rate of a USB-C connection.
 *
 * The connected device and host port are considered ahead of the cable, so the
 * diagnosis never blames a cable when replacing it would not help. A missing
 * cable rating yields an honest `unknown-cable` rather than a guess.
 *
 * @param {DataLinkInputs} inputs Capability figures.
 * @returns {{
 *   bottleneck: string,
 *   limitedToGbps: number | undefined,
 *   verdict: string
 * }} Diagnosis.
 */
export function dataLinkDiagnostic(inputs) {
  const { hostGbps, cableGbps, deviceGbps, negotiatedGbps } = inputs;

  const ceiling = minimumDefined(hostGbps, cableGbps, deviceGbps);
  if (ceiling === undefined) {
    return {
      bottleneck: "unknown-cable",
      limitedToGbps: negotiatedGbps,
      verdict: "Link capability could not be determined",
    };
  }

  const candidates = [
    { name: "device-limit", label: "Connected device", value: deviceGbps },
    { name: "host-limit", label: "Host port", value: hostGbps },
    { name: "cable-limit", label: "Cable", value: cableGbps },
  ];

  for (const candidate of candidates) {
    if (candidate.value !== undefined && isSameTier(candidate.value, ceiling)) {
      const isFine = candidates.every(
        (other) =>
          other.value === undefined || !isMeaningfullyBelow(other, candidates),
      );
      if (isFine && ceiling === maxDefined(hostGbps, cableGbps, deviceGbps)) {
        return {
          bottleneck: "fine",
          limitedToGbps: ceiling,
          verdict: `Running at up to ${ceiling} Gbps`,
        };
      }
      return {
        bottleneck: candidate.name,
        limitedToGbps: ceiling,
        verdict: `${candidate.label} limits this link to ${ceiling} Gbps`,
      };
    }
  }

  return {
    bottleneck: "degraded",
    limitedToGbps: negotiatedGbps ?? ceiling,
    verdict: `Link is running below the capability of its components`,
  };
}

/**
 * @typedef {object} CableTrustInputs
 * @property {number} [vendorId] Decoded cable vendor id.
 * @property {boolean} [eprCapable] Whether the cable claims extended power range.
 * @property {number} [maxVbusVoltage] Advertised maximum VBUS voltage.
 * @property {string[]} [decodeWarnings] Warnings raised while decoding the cable.
 */

/**
 * Produce note-level observations about a cable's e-marker consistency.
 *
 * These notes deliberately never assert that a cable is counterfeit. They fire
 * on genuine hardware too, so they are reported as observations for a reader to
 * weigh rather than as a verdict. A zero vendor id alongside an otherwise
 * well-formed cable is common on compliant hardware, so it is only noted when it
 * is the sole signal.
 *
 * @param {CableTrustInputs} inputs Decoded cable fields.
 * @returns {string[]} Trust notes.
 */
export function cableTrustNotes(inputs) {
  const notes = [];

  if (inputs.vendorId === 0) {
    notes.push("Cable reports a zero vendor id");
  }

  if (
    inputs.eprCapable === true &&
    inputs.maxVbusVoltage !== undefined &&
    inputs.maxVbusVoltage <= 20
  ) {
    notes.push("Cable claims extended power range but only a 20V rating");
  }

  for (const warning of inputs.decodeWarnings ?? []) {
    notes.push(warning);
  }

  return notes;
}

/**
 * Return the smallest defined value from the arguments.
 *
 * @param {...(number | undefined)} values Candidate values.
 * @returns {number | undefined} Minimum defined value or undefined.
 */
function minimumDefined(...values) {
  const defined = values.filter((value) => value !== undefined);
  return defined.length ? Math.min(...defined) : undefined;
}

/**
 * Return the largest defined value from the arguments.
 *
 * @param {...(number | undefined)} values Candidate values.
 * @returns {number | undefined} Maximum defined value or undefined.
 */
function maxDefined(...values) {
  const defined = values.filter((value) => value !== undefined);
  return defined.length ? Math.max(...defined) : undefined;
}

/**
 * Report whether an actual figure is meaningfully below a ceiling.
 *
 * @param {number} actual Observed value.
 * @param {number} ceiling Available ceiling.
 * @returns {boolean} True when the shortfall exceeds tolerance.
 */
function meaningfullyBelow(actual, ceiling) {
  const tolerance = Math.max(
    CHARGING_TOLERANCE_WATTS,
    ceiling * CHARGING_TOLERANCE_RATIO,
  );
  return actual + tolerance < ceiling;
}

/**
 * Report whether two data rates belong to the same tier.
 *
 * @param {number} a First rate.
 * @param {number} b Second rate.
 * @returns {boolean} True when the rates are within one tier.
 */
function isSameTier(a, b) {
  const larger = Math.max(a, b);
  return Math.abs(a - b) <= larger * SAME_TIER_RATIO;
}

/**
 * Helper for {@link dataLinkDiagnostic} that reports whether a candidate is the
 * clear low point among all candidates.
 *
 * @param {{ value: number | undefined }} candidate Candidate under test.
 * @param {Array<{ value: number | undefined }>} candidates All candidates.
 * @returns {boolean} True when the candidate is meaningfully the slowest.
 */
function isMeaningfullyBelow(candidate, candidates) {
  if (candidate.value === undefined) {
    return false;
  }
  return candidates.some(
    (other) =>
      other.value !== undefined &&
      other !== candidate &&
      !isSameTier(candidate.value, other.value) &&
      candidate.value < other.value,
  );
}
