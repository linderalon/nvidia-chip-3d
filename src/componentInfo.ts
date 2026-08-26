export type ComponentInfo = {
  id: string;
  title: string;
  role: string;
  color: string;
  bullets: [string, string, string];
};

// Technical reference content for engineer training/onboarding. Grounded in the
// Jetson AGX Xavier module's publicly documented architecture (Tegra Xavier SoC,
// LPDDR4x memory subsystem, multi-rail power delivery, high-density mezzanine
// connector). Where an exact spec (pin count, rail count) isn't confidently known
// from the reference photos alone, described qualitatively rather than guessed.
export const COMPONENT_INFO: ComponentInfo[] = [
  {
    id: 'soc-package',
    title: 'Xavier SoC (Tegra Xavier)',
    role: 'System-on-chip — compute core of the module',
    color: '#1F6B6B',
    bullets: [
      'A single flip-chip BGA package under the black overmold lid integrates six distinct compute engines on one die: 8-core NVIDIA Carmel ARMv8.2 CPU cluster, a 512-core Volta GPU with 64 Tensor Cores, two NVDLA deep-learning accelerators, a 7-way VLIW Programmable Vision Accelerator (PVA), a stereo/optical-flow engine, and hardware video encode/decode blocks — this heterogeneous mix is why Xavier can run perception, planning, and encode pipelines concurrently without one workload starving another.',
      'The die sits directly beneath the largest thermal interface on the module: in the real assembly this package mates to the carrier\'s heatsink/thermal plate through this exact footprint, so this is the dominant heat source engineers need to budget for when designing enclosures — Xavier\'s configurable TDP spans roughly 10–30W depending on the selected power mode (nvpmodel).',
      'All other populated zones on this board exist to serve this package: the VRM bank upstream supplies its multiple voltage rails (separate domains for CPU, GPU, SoC logic, and I/O), the memory packages flanking it are wired directly to its integrated memory controller, and the edge connector on the reverse face breaks its PCIe/MIPI-CSI/USB/display lanes out to the carrier board.',
    ],
  },
  {
    id: 'vrm-bank',
    title: 'VRM Bank (Power Delivery Stage)',
    role: 'Multi-rail voltage regulation for the SoC',
    color: '#8a6b3f',
    bullets: [
      'The row of large molded inductors (silkscreened "R22" in the reference photos) paired with the ceramic capacitor banks beneath them forms a set of multi-phase buck converters — each phase steps the module\'s input rail down to one of several lower voltages the Xavier die needs simultaneously (separate rails typically exist for CPU, GPU, SoC/logic, and DRAM I/O, since each domain has different voltage and transient-response requirements).',
      'Multi-phase design (repeating identical inductor+capacitor stages rather than one large stage) is a deliberate engineering choice: splitting the load current across phases reduces the RMS current and heat in any single inductor, improves transient response when the GPU/DLA suddenly ramps up under a burst workload, and reduces output ripple compared to a single-phase regulator of equivalent total power.',
      'This is a common first inspection point when diagnosing power-related instability or brownout resets in the field — a failed or degraded inductor/capacitor in this bank shows up as rail droop under load well before it causes a hard failure, so engineers should know this zone by sight when reading a board photo or thermal image.',
    ],
  },
  {
    id: 'memory-pmic-cluster',
    title: 'Memory & PMIC Packages',
    role: 'LPDDR4x memory and power-management ICs',
    color: '#4a4a4a',
    bullets: [
      'The smaller packages flanking and below the SoC are a mix of LPDDR4x memory die (providing the module\'s unified CPU/GPU memory pool over a 256-bit interface) and power-management ICs (PMICs) that sequence and monitor the VRM bank\'s output rails — on the production module these are typically markings like "D9WX"/"B0077" style part codes rather than generic silkscreen.',
      'Because Xavier uses a single shared LPDDR4x pool for both CPU and GPU (rather than separate host and device memory), the physical proximity and trace length from these packages to the SoC package matters for signal integrity at the memory interface\'s operating frequency — this is why they\'re placed immediately adjacent to the die rather than elsewhere on the board.',
      'PMICs in this cluster typically also expose telemetry (voltage/current monitoring, e.g. via an INA3221-style power monitor on the production carrier) that feeds into the software power model — this is the hardware behind tools like `tegrastats`/`jetson_clocks` that report live rail power on a running unit, so this cluster is the physical link between what you see on a board and what you read in software telemetry.',
    ],
  },
  {
    id: 'edge-connector',
    title: 'High-Density Edge Connector',
    role: 'Board-to-board interconnect to the carrier board',
    color: '#3a3a3a',
    bullets: [
      'This dense multi-row mezzanine connector is how the entire module attaches to a carrier board — Xavier modules are designed as a SO-DIMM-style compute module rather than a fixed single-board computer specifically so the same module can be redesigned into different carrier form factors (devkit, industrial, custom) without respinning the SoC-side design.',
      'The connector carries a wide mix of signal types simultaneously: PCIe lanes, MIPI CSI-2 camera lanes, USB, Gigabit Ethernet, display outputs, and lower-speed GPIO/I2C/SPI/UART — high-speed differential pairs are grouped and length-matched within the connector\'s row structure to control signal skew, which is why the contact rows are visually organized into distinct bands rather than randomly distributed.',
      'This is the single most mechanically critical part of the module for field engineers: connector seating force, coplanarity between module and carrier, and standoff height (see the mounting standoffs) all directly affect signal integrity here — a marginal connection at this interface is a classic root cause of intermittent camera/PCIe dropouts that don\'t reproduce under static bench testing.',
    ],
  },
  {
    id: 'mounting-standoffs',
    title: 'Mounting Standoffs',
    role: 'Mechanical + thermal mounting points',
    color: '#2a180f',
    bullets: [
      'The four bosses at the board corners are both a mechanical fixation point (screwing the module to the carrier board or a heatsink/thermal transfer plate) and part of the thermal path — because the SoC has no fan of its own, consistent, even clamping force across these four points is what keeps the die-to-heatsink thermal interface in even contact across the whole package.',
      'Uneven torque across the four standoffs (over-tightening one corner before others) is a well-known cause of inconsistent thermal throttling between otherwise-identical units on a production line — one corner running hotter than the others under load is a strong first symptom to check against standoff torque/seating before suspecting the SoC or firmware.',
      'These four points, together with the edge connector, are the only mechanical contact between the module and the rest of the system — every other component on this board is floating relative to the carrier and relies entirely on these standoffs plus the connector for positional stability, which is why they\'re specified with tight tolerances on the real module despite looking like a minor detail.',
    ],
  },
];
