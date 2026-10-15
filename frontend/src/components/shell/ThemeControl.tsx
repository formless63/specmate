import { ActionIcon, Menu, useComputedColorScheme, useMantineColorScheme } from "@mantine/core";

/** Always reachable, including before sign-in. System follows the OS until overridden. */
export function ThemeControl() {
  const { colorScheme, setColorScheme } = useMantineColorScheme();
  const computed = useComputedColorScheme("light");
  const label = colorScheme === "auto" ? "System" : colorScheme === "dark" ? "Dark" : "Light";
  return <Menu position="bottom-end" withinPortal>
    <Menu.Target><ActionIcon variant="subtle" color="var(--sb-text-primary)" size={30} style={{ flexShrink: 0 }} aria-label={`Theme: ${label}`} title={`Theme: ${label}`}>
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
        {computed === "dark" ? <path d="M20 15A8.5 8.5 0 0 1 9 4a8.5 8.5 0 1 0 11 11Z" /> : <><circle cx="12" cy="12" r="4" /><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5" /></>}
      </svg>
    </ActionIcon></Menu.Target>
    <Menu.Dropdown><Menu.Label>Appearance</Menu.Label><Menu.RadioGroup value={colorScheme} onChange={value => setColorScheme(value as "auto" | "light" | "dark")}>
      {([["auto", "System"], ["light", "Light"], ["dark", "Dark"]] as const).map(([value, name]) =>
        <Menu.RadioItem key={value} value={value} closeMenuOnClick>{name}</Menu.RadioItem>
      )}
    </Menu.RadioGroup></Menu.Dropdown>
  </Menu>;
}
