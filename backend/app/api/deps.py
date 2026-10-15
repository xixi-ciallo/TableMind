# 依赖中转文件，方便路由统一从 app.api.deps 导入
# 当前所有依赖（get_db / get_current_user / require_admin）已在 core 中定义

from app.core.database import get_db
from app.core.security import get_current_user, get_optional_user, require_admin

__all__ = ["get_db", "get_current_user", "get_optional_user", "require_admin"]
