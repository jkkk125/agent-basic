import { asc, eq } from 'drizzle-orm';
import { db } from './drizzle/index.ts';
import { models, providers } from './drizzle/schema.ts';

export type ProviderRow = typeof providers.$inferSelect;
export type ModelRow = typeof models.$inferSelect;

export type ActiveModelConfig = {
  /** 数据库里的模型别名 */
  alias: string;
  /** 供应商名称 */
  providerName: string;
  baseUrl: string;
  apiKey: string;
  modelId: string;
};

export type ProviderWithModels = ProviderRow & {
  models: ModelRow[];
};

/** 脱敏展示 API Key，避免终端输出完整密钥 */
export function maskApiKey(apiKey: string): string {
  const trimmed = apiKey.trim();
  if (trimmed.length <= 8) return '***';
  return `${trimmed.slice(0, 4)}...${trimmed.slice(-4)}`;
}

/** 从 SQLite 查询当前激活模型及其所属供应商 */
export function getActiveModelConfig(): ActiveModelConfig | null {
  const row = db
    .select({
      alias: models.name,
      modelId: models.model_id,
      providerName: providers.name,
      baseUrl: providers.base_url,
      apiKey: providers.api_key,
    })
    .from(models)
    .innerJoin(providers, eq(models.provider_id, providers.id))
    .where(eq(models.is_active, true))
    .limit(1)
    .get();

  if (!row) return null;

  return {
    alias: row.alias,
    providerName: row.providerName,
    baseUrl: row.baseUrl,
    apiKey: row.apiKey,
    modelId: row.modelId,
  };
}

export function listProviders(): ProviderRow[] {
  return db.select().from(providers).orderBy(asc(providers.name)).all();
}

export function getProviderByName(name: string): ProviderRow | null {
  return db.select().from(providers).where(eq(providers.name, name)).limit(1).get() ?? null;
}

export function listProvidersWithModels(): ProviderWithModels[] {
  const allProviders = listProviders();
  const allModels = db.select().from(models).orderBy(asc(models.name)).all();

  const byProvider = new Map<string, ModelRow[]>();
  for (const model of allModels) {
    const list = byProvider.get(model.provider_id) ?? [];
    list.push(model);
    byProvider.set(model.provider_id, list);
  }

  return allProviders.map((provider) => ({
    ...provider,
    models: byProvider.get(provider.id) ?? [],
  }));
}

export function createProvider(input: {
  name: string;
  baseUrl: string;
  apiKey: string;
}): ProviderRow {
  const name = input.name.trim();
  const baseUrl = input.baseUrl.trim();
  const apiKey = input.apiKey.trim();

  if (!name) throw new Error('供应商名称不能为空');
  if (!baseUrl) throw new Error('Base URL 不能为空');
  if (!apiKey) throw new Error('API Key 不能为空');

  const existing = getProviderByName(name);
  if (existing) {
    throw new Error(`供应商 "${name}" 已存在`);
  }

  const created = db
    .insert(providers)
    .values({
      name,
      base_url: baseUrl,
      api_key: apiKey,
    })
    .returning()
    .get();

  if (!created) {
    throw new Error(`创建供应商 "${name}" 失败`);
  }
  return created;
}

export function updateProvider(
  name: string,
  patch: { baseUrl?: string; apiKey?: string },
): ProviderRow {
  const existing = getProviderByName(name);
  if (!existing) {
    throw new Error(`未找到供应商 "${name}"`);
  }

  const nextBaseUrl = patch.baseUrl?.trim();
  const nextApiKey = patch.apiKey?.trim();

  const updated = db
    .update(providers)
    .set({
      ...(nextBaseUrl ? { base_url: nextBaseUrl } : {}),
      ...(nextApiKey ? { api_key: nextApiKey } : {}),
      updated_at: new Date(),
    })
    .where(eq(providers.id, existing.id))
    .returning()
    .get();

  if (!updated) {
    throw new Error(`更新供应商 "${name}" 失败`);
  }
  return updated;
}

export function deleteProvider(name: string): { deleted: ProviderRow; hadActiveModel: boolean } {
  return db.transaction((tx) => {
    const existing = tx
      .select()
      .from(providers)
      .where(eq(providers.name, name))
      .limit(1)
      .get();

    if (!existing) {
      throw new Error(`未找到供应商 "${name}"`);
    }

    const activeRow = tx
      .select({ provider_id: models.provider_id })
      .from(models)
      .where(eq(models.is_active, true))
      .limit(1)
      .get();
    const hadActiveModel = activeRow?.provider_id === existing.id;

    tx.delete(providers).where(eq(providers.id, existing.id)).run();
    return { deleted: existing, hadActiveModel };
  });
}

export function createModel(input: {
  providerId: string;
  name: string;
  modelId: string;
  activate?: boolean;
}): ModelRow {
  const name = input.name.trim();
  const modelId = input.modelId.trim();

  if (!name) throw new Error('模型别名不能为空');
  if (!modelId) throw new Error('Model ID 不能为空');

  return db.transaction((tx) => {
    const provider = tx
      .select({ id: providers.id })
      .from(providers)
      .where(eq(providers.id, input.providerId))
      .limit(1)
      .get();
    if (!provider) {
      throw new Error(`未找到供应商 ID "${input.providerId}"`);
    }

    const dup = tx
      .select({ id: models.id })
      .from(models)
      .where(eq(models.name, name))
      .limit(1)
      .get();
    if (dup) {
      throw new Error(`模型别名 "${name}" 已存在`);
    }

    const hasActive = !!tx
      .select({ id: models.id })
      .from(models)
      .where(eq(models.is_active, true))
      .limit(1)
      .get();

    const shouldActivate = input.activate ?? !hasActive;
    if (shouldActivate && hasActive) {
      tx.update(models)
        .set({ is_active: false, updated_at: new Date() })
        .where(eq(models.is_active, true))
        .run();
    }

    const created = tx
      .insert(models)
      .values({
        provider_id: input.providerId,
        name,
        model_id: modelId,
        is_active: shouldActivate,
      })
      .returning()
      .get();

    if (!created) {
      throw new Error(`创建模型 "${name}" 失败`);
    }
    return created;
  });
}

/** 原子切换默认激活模型：先校验目标存在，再清旧置新，失败不影响原激活项 */
export function setActiveModel(name: string): ActiveModelConfig {
  db.transaction((tx) => {
    const target = tx
      .select({ id: models.id })
      .from(models)
      .where(eq(models.name, name))
      .limit(1)
      .get();

    if (!target) {
      throw new Error(`未找到模型 "${name}"`);
    }

    const now = new Date();
    tx.update(models)
      .set({ is_active: false, updated_at: now })
      .where(eq(models.is_active, true))
      .run();

    tx.update(models)
      .set({ is_active: true, updated_at: now })
      .where(eq(models.id, target.id))
      .run();
  });

  const active = getActiveModelConfig();
  if (!active) {
    throw new Error(`切换模型 "${name}" 后读取配置失败`);
  }
  return active;
}

export function deleteModel(name: string): { deleted: ModelRow; wasActive: boolean } {
  return db.transaction((tx) => {
    const existing = tx
      .select()
      .from(models)
      .where(eq(models.name, name))
      .limit(1)
      .get();

    if (!existing) {
      throw new Error(`未找到模型 "${name}"`);
    }

    tx.delete(models).where(eq(models.id, existing.id)).run();
    return { deleted: existing, wasActive: existing.is_active };
  });
}
