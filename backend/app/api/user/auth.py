from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_db
from app.core.security import (
    create_access_token,
    get_current_user,
    hash_password,
    verify_password,
)
from app.models.user import User
from app.schemas.user import AuthResponse, UserCreate, UserLogin, UserOut

router = APIRouter()


def _auth_response(user: User) -> AuthResponse:
    """统一构造注册/登录响应：令牌 + 用户信息"""
    return AuthResponse(
        access_token=create_access_token(user.id, user.role),
        token_type="bearer",
        user=UserOut.model_validate(user),
    )


@router.post("/register", response_model=AuthResponse, status_code=status.HTTP_201_CREATED)
async def register(data: UserCreate, db: AsyncSession = Depends(get_db)):
    """用户注册：手机号作为登录凭证，用户名与手机号都要求唯一。

    唯一性在数据库层由唯一索引兜底，这里先查一次给出友好提示，
    并发写入时捕获 IntegrityError 再兜底，避免出现重复账号。
    """
    # 手机号已在 schema 层规范化（去空格/去 +86 前缀）
    exists = await db.execute(
        select(User.id).where(
            or_(User.username == data.username, User.phone == data.phone)
        )
    )
    if exists.first():
        # 分别判断，给出精确提示
        by_username = await db.execute(
            select(User.id).where(User.username == data.username)
        )
        if by_username.first():
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="该用户名已被注册，请换一个",
            )
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="该手机号已被注册，请直接登录或更换号码",
        )

    user = User(
        username=data.username,
        phone=data.phone,
        password_hash=hash_password(data.password),
        role="user",
        is_active=True,
    )
    db.add(user)
    try:
        await db.commit()
    except IntegrityError:
        await db.rollback()
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="该手机号或用户名已被注册",
        )
    await db.refresh(user)
    return _auth_response(user)


@router.post("/login", response_model=AuthResponse)
async def login(data: UserLogin, db: AsyncSession = Depends(get_db)):
    """用户登录：用户名或手机号 + 密码"""
    account = data.username.strip()
    result = await db.execute(
        select(User).where(or_(User.username == account, User.phone == account))
    )
    user = result.scalar_one_or_none()
    if not user or not verify_password(data.password, user.password_hash):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="用户名/手机号或密码错误",
            headers={"WWW-Authenticate": "Bearer"},
        )
    if not user.is_active:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="账号已被禁用，请联系管理员",
        )
    return _auth_response(user)


@router.get("/me", response_model=UserOut)
async def me(current_user: User = Depends(get_current_user)):
    """获取当前登录用户，用于前端刷新页面后恢复登录态"""
    return current_user
