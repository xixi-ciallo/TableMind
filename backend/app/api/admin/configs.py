"""P4 管理端系统配置：查看生效值、在线修改、恢复默认、审计与回滚。

写入立即改进程内 settings，因此检索/生成/评测下一请求即生效，无需重启。
"""
import logging
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_db, require_admin
from app.core import runtime_config
from app.core.config import settings
from app.models.app_config import AppConfig, AppConfigAudit
from app.models.user import User
from app.schemas.config import ConfigAuditOut, ConfigItemOut, ConfigUpdateIn

router = APIRouter()
log = logging.getLogger(__name__)


def _source(spec: runtime_config.ConfigSpec, row: Any | None) -> str:
    """数据库有值且能解析才算覆盖；脏值按 .env 生效，避免页面显示假状态。"""
    if row is None:
        return "env"
    try:
        runtime_config.coerce(spec, row.value)
    except ValueError:
        return "env"
    return "db"


def _item(spec: runtime_config.ConfigSpec, row: Any | None) -> ConfigItemOut:
    source = _source(spec, row)
    return ConfigItemOut(
        key=spec.key,
        group=spec.group,
        label=spec.label,
        description=spec.description,
        kind=spec.kind,
        value=getattr(settings, spec.key),
        default=runtime_config.ENV_DEFAULTS[spec.key],
        source=source,
        options=list(spec.options),
        minimum=spec.minimum,
        maximum=spec.maximum,
        step=spec.step,
        updated_at=row.updated_at if source == "db" and row else None,
        updated_by_name=row.updated_by_name if source == "db" and row else None,
    )


async def _get_item(db: AsyncSession, key: str) -> ConfigItemOut:
    spec = runtime_config.REGISTRY.get(key)
    if spec is None:
        raise HTTPException(status_code=404, detail="该配置项不存在或不允许在线修改")
    # 按列查询而不是 db.get：写接口 commit 后 ORM 实例属性已过期，
    # 再同步访问 updated_at 会触发懒加载并抛 MissingGreenlet。
    row = (
        await db.execute(
            select(
                AppConfig.value,
                AppConfig.updated_at,
                AppConfig.updated_by_name,
            ).where(AppConfig.key == key)
        )
    ).first()
    return _item(spec, row)


@router.get("/configs/audits", response_model=list[ConfigAuditOut])
async def list_audits(
    key: str | None = None,
    limit: int = 50,
    db: AsyncSession = Depends(get_db),
):
    """变更历史，按时间倒序；key 为空时返回全部配置的最近变更。"""
    limit = max(1, min(limit, 200))
    stmt = select(AppConfigAudit).order_by(AppConfigAudit.id.desc()).limit(limit)
    if key:
        stmt = stmt.where(AppConfigAudit.key == key)
    return (await db.execute(stmt)).scalars().all()


@router.post("/configs/audits/{audit_id}/rollback", response_model=ConfigItemOut)
async def rollback_audit(
    audit_id: int,
    db: AsyncSession = Depends(get_db),
    admin: User = Depends(require_admin),
):
    """把某个键恢复成指定审计记录里的旧值，并再记一条 rollback 审计。"""
    audit = await db.get(AppConfigAudit, audit_id)
    if audit is None:
        raise HTTPException(status_code=404, detail="变更记录不存在")
    spec = runtime_config.REGISTRY.get(audit.key)
    if spec is None:
        raise HTTPException(status_code=400, detail="该配置项已下线，无法回滚")

    current = getattr(settings, spec.key)
    row = await db.get(AppConfig, spec.key)

    if audit.old_value is None:
        # 旧记录没有值 → 回滚等价于恢复 .env 默认（删除覆盖）
        target = runtime_config.ENV_DEFAULTS[spec.key]
        if row is not None:
            await db.delete(row)
    else:
        try:
            target = runtime_config.coerce(spec, audit.old_value)
        except ValueError:
            raise HTTPException(status_code=400, detail="该记录里的旧值已不合法，无法回滚")
        serialized = runtime_config.serialize(spec, target)
        if target == runtime_config.ENV_DEFAULTS[spec.key]:
            # 旧值就是 .env 默认值：删除覆盖，让来源标记也回到 env
            if row is not None:
                await db.delete(row)
        elif row is None:
            row = AppConfig(key=spec.key, value=serialized)
            row.updated_by_id = admin.id
            row.updated_by_name = admin.username
            db.add(row)
        else:
            row.value = serialized
            row.updated_by_id = admin.id
            row.updated_by_name = admin.username

    db.add(
        AppConfigAudit(
            key=spec.key,
            action="rollback",
            old_value=runtime_config.serialize(spec, current),
            new_value=runtime_config.serialize(spec, target),
            operator_id=admin.id,
            operator_name=admin.username,
        )
    )
    await db.commit()
    runtime_config.apply_single(spec.key, target)
    log.info("配置回滚：%s → %s（操作人 %s）", spec.key, target, admin.username)
    return await _get_item(db, spec.key)


@router.get("/configs", response_model=list[ConfigItemOut])
async def list_configs(db: AsyncSession = Depends(get_db)):
    rows = (await db.execute(select(AppConfig))).scalars().all()
    by_key = {row.key: row for row in rows}
    return [
        _item(spec, by_key.get(spec.key)) for spec in runtime_config.REGISTRY.values()
    ]


@router.put("/configs/{key}", response_model=ConfigItemOut)
async def update_config(
    key: str,
    payload: ConfigUpdateIn,
    db: AsyncSession = Depends(get_db),
    admin: User = Depends(require_admin),
):
    spec = runtime_config.REGISTRY.get(key)
    if spec is None:
        raise HTTPException(status_code=404, detail="该配置项不存在或不允许在线修改")
    try:
        value = runtime_config.coerce(spec, payload.value)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    serialized = runtime_config.serialize(spec, value)
    current = getattr(settings, spec.key)
    row = await db.get(AppConfig, key)
    if row is None:
        row = AppConfig(key=key, value=serialized)
        db.add(row)
    else:
        row.value = serialized
    row.updated_by_id = admin.id
    row.updated_by_name = admin.username
    db.add(
        AppConfigAudit(
            key=key,
            action="set",
            old_value=runtime_config.serialize(spec, current),
            new_value=serialized,
            operator_id=admin.id,
            operator_name=admin.username,
        )
    )
    await db.commit()
    runtime_config.apply_single(key, value)
    log.info("配置修改：%s=%s（操作人 %s）", key, value, admin.username)
    return await _get_item(db, key)


@router.delete("/configs/{key}", response_model=ConfigItemOut)
async def reset_config(
    key: str,
    db: AsyncSession = Depends(get_db),
    admin: User = Depends(require_admin),
):
    """删除数据库覆盖，回到 .env 值。"""
    spec = runtime_config.REGISTRY.get(key)
    if spec is None:
        raise HTTPException(status_code=404, detail="该配置项不存在或不允许在线修改")

    current = getattr(settings, spec.key)
    row = await db.get(AppConfig, key)
    if row is not None:
        await db.delete(row)
    default = runtime_config.ENV_DEFAULTS[key]
    db.add(
        AppConfigAudit(
            key=key,
            action="reset",
            old_value=runtime_config.serialize(spec, current),
            new_value=runtime_config.serialize(spec, default),
            operator_id=admin.id,
            operator_name=admin.username,
        )
    )
    await db.commit()
    runtime_config.reset_single(key)
    log.info("配置恢复默认：%s=%s（操作人 %s）", key, default, admin.username)
    return await _get_item(db, key)
