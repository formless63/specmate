export type SourceFileRole = 'application' | 'library' | 'configuration' | 'board_support' | 'lockfile' | 'other';
export type FirmwareSource = {
  local_id: string; source_revision_id: string; source_manifest_sha256: string;
  files: { path: string; sha256: string; rights: string; role: SourceFileRole }[];
};
export type ConfigEntry = { key: string; status: 'known' | 'unknown' | 'secret_reference'; value: string | null };
export type Toolchain = {
  family: 'platformio' | 'esp_idf' | 'arduino_cli' | 'zephyr' | 'cmake_gcc' | 'other';
  name: string; version: string | null; framework: string | null; board_id: string | null;
};
export type PinFunction = 'gpio_in' | 'gpio_out' | 'gpio_bidir' | 'analog_in' | 'pwm_out' | 'uart_tx' | 'uart_rx' | 'i2c_sda' | 'i2c_scl'
  | 'spi_sck' | 'spi_mosi' | 'spi_miso' | 'spi_cs' | 'can_tx' | 'can_rx' | 'usb_dp' | 'usb_dm' | 'other';
export type PinAssumption = {
  signal: string; pad_id: string | null; function: PinFunction; peripheral: string | null;
  expected_net: string | null; peer_pad_id: string | null; basis: string | null;
};
export type Firmware = {
  schema_version?: '1'; sources: FirmwareSource[]; configuration: ConfigEntry[]; toolchain: Toolchain;
  target: { population_revision_id: string; option_id: string; component_id: string; declared_part: string | null };
  pins: PinAssumption[];
};
export type FindingStatus = 'valid' | 'invalid' | 'unknown' | 'not_evaluated';
export type Finding = { code: string; status: FindingStatus; message: string; subject: { signal?: string; key?: string } };
export type Evaluation = {
  sources: (FirmwareSource & { bundle_name: string; revision_number: number; manifest_sha256: string })[];
  target: {
    population_revision_id: string; population_name: string; population_number: number; population_snapshot_sha256: string;
    option_id: string; option_name: string | null; interpretation_id: string; interpretation_sha256: string; board_source_revision_id: string;
    component: { id: string; reference: string; value: string; footprint: string; native_dnp: boolean } | null;
    declared_part: string | null; pads: { id: string; terminal: string; net: string; type: string }[];
  };
  findings: Finding[]; counts: Record<FindingStatus, number>; readiness: 'blocked' | 'declared_with_unknowns' | 'declared';
  toolchain_support: 'declared_not_verified'; compilation: 'not_performed'; flashing: 'not_performed'; device_operation: 'not_observed';
};
export type FirmwareRead = {
  definition_id: string; name: string; draft_id: string | null; state: string | null; revision_id: string | null;
  revision_number: number | null; snapshot_sha256: string | null; content: { firmware: Firmware }; evaluation: Evaluation;
};
export type FirmwareSummary = { definition_id: string; name: string; draft_id: string | null; revisions: { revision_id: string; number: number }[] };
export type TargetSummary = { revision_id: string; name: string; number: number; snapshot_sha256: string };
export type PopulationReview = {
  population: { options: { local_id: string; name: string; decisions: { component_id: string; status: 'populate' | 'omit' | null }[] }[] };
  report: { components: { id: string; reference: string; value: string }[]; pads: { id: string; component_id: string; terminal: string; net: string; type: string }[] };
};
export type AssignmentReview = {
  assembly_snapshot_id: string;
  assignments: { path: string[]; display_ref: string; occurrence_revision_id: string; occurrence_kind: string; firmware_revision_id: string;
    firmware_name: string; status: FindingStatus; message: string; target_population_revision_id?: string }[];
};
export const FUNCTIONS: PinFunction[] = ['gpio_in', 'gpio_out', 'gpio_bidir', 'analog_in', 'pwm_out', 'uart_tx', 'uart_rx', 'i2c_sda', 'i2c_scl',
  'spi_sck', 'spi_mosi', 'spi_miso', 'spi_cs', 'can_tx', 'can_rx', 'usb_dp', 'usb_dm', 'other'];
