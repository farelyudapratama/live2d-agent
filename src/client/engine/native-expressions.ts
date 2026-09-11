/** Koleksi nama ekspresi native dari seluruh surface pixi-live2d yang dikenal. */
type NamedExpression = { Name?: unknown } | null | undefined;
type ExpressionModel = {
  expressions?: unknown;
  internalModel?: {
    motionManager?: { expressionManager?: { definitions?: unknown } };
    settings?: { expressions?: unknown };
  };
};

function safeRead(read: () => unknown): unknown {
  try { return read(); } catch { return undefined; }
}

function appendNames(out: string[], value: unknown): void {
  if (!Array.isArray(value)) return;
  for (const item of value as NamedExpression[]) {
    const name = safeRead(() => item && item.Name);
    if (typeof name === "string" && name.trim().length > 0) out.push(name);
  }
}

function objectKeys(value: object): string[] {
  const keys = safeRead(() => Object.keys(value));
  return Array.isArray(keys) ? keys : [];
}

export function collectNativeExpressions(model: ExpressionModel | null | undefined): string[] {
  if (!model) return [];
  const names: string[] = [];
  const direct = safeRead(() => model.expressions);
  if (Array.isArray(direct)) {
    for (const value of direct) {
      if (typeof value === "string" && value.trim().length > 0) names.push(value);
    }
  } else if (direct && typeof direct === "object") {
    names.push(...objectKeys(direct));
  }
  appendNames(names, safeRead(() => model.internalModel?.motionManager?.expressionManager?.definitions));
  appendNames(names, safeRead(() => model.internalModel?.settings?.expressions));
  return Array.from(new Set(names));
}
