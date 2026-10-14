/** Test helper: the reported permission list a role with the given capabilities would hold. */
export function grants({ edit = false, freeze = false, execute = false, create = edit, register = false }: { edit?: boolean; freeze?: boolean; execute?: boolean; create?: boolean; register?: boolean } = {}): string[] {
  return [
    "workspace.read",
    ...(edit ? ["design.edit"] : []),
    ...(create ? ["item.create"] : []),
    ...(freeze ? ["design.freeze"] : []),
    ...(execute ? ["build.execute"] : []),
    ...(register ? ["source.register"] : []),
  ];
}
