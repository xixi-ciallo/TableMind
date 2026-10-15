import { useNavigate } from 'react-router-dom';
import type { GameDetail } from './gameLibrary';
import { coverGradient } from './coverGradient';

interface GameCardProps {
  game: GameDetail;
  /** 页面传 link 角色；列表中的卡片统一可键盘操作 */
  rank?: number;
  /** 展示紧凑信息（横滑列表用） */
  compact?: boolean;
  /** 宽度模式：fluid 占满容器；fixed 用于横向滚动 */
  widthMode?: 'fluid' | 'fixed';
  fixedWidth?: number;
}

/**
 * 桌游卡片（参考 TapTap 游戏卡片：大封面 + 名称 + 关键信息 + 标签）。
 * - 封面为真实盒装图，hover 时轻微放大
 * - 悬浮抬升与按压反馈由 .tm-card 提供（纯 CSS，滚动更顺滑）
 */
export default function GameCard({
  game,
  rank,
  compact = false,
  widthMode = 'fluid',
  fixedWidth = 190,
}: GameCardProps) {
  const navigate = useNavigate();
  const to = `/games/${game.slug}`;

  const activate = () => navigate(to);

  return (
    <div
      role="link"
      tabIndex={0}
      aria-label={`${game.name}（${game.name_en}），${game.min_players}-${game.max_players} 人，${game.play_time_text}`}
      className="tm-card"
      onClick={activate}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          activate();
        }
      }}
      style={{
        width: widthMode === 'fixed' ? fixedWidth : '100%',
        background: '#fff',
        borderRadius: 14,
        overflow: 'hidden',
        boxShadow: '0 2px 8px rgba(17,24,39,.06)',
        flexShrink: 0,
        cursor: 'pointer',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {/* 封面 */}
      <div
        style={{
          position: 'relative',
          aspectRatio: '4 / 5',
          background: '#f2f3f5',
          overflow: 'hidden',
        }}
      >
        {game.cover_image ? (
          <img
            src={game.cover_image}
            alt={`${game.name} 盒装封面`}
            loading="lazy"
            decoding="async"
            className="tm-img tm-zoom"
            style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
          />
        ) : (
          <div
            style={{
              width: '100%',
              height: '100%',
              background: coverGradient(game.id),
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: 'rgba(255,255,255,.92)',
              fontSize: 46,
              fontWeight: 700,
            }}
            aria-hidden
          >
            {game.name.charAt(0)}
          </div>
        )}

        {/* 名次角标（排行榜用） */}
        {rank != null && (
          <span
            aria-label={`第 ${rank} 名`}
            style={{
              position: 'absolute',
              left: 8,
              top: 8,
              minWidth: 24,
              height: 24,
              padding: '0 7px',
              borderRadius: 8,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 12,
              fontWeight: 700,
              color: '#fff',
              background:
                rank === 1 ? '#d93d1a' : rank === 2 ? '#e8763f' : rank === 3 ? '#c9922f' : 'rgba(26,26,26,.62)',
              backdropFilter: 'blur(4px)',
            }}
          >
            {rank}
          </span>
        )}
      </div>

      {/* 信息 */}
      <div style={{ padding: compact ? '9px 10px 11px' : '11px 12px 13px', flex: 1 }}>
        <div
          className="tm-clamp-1"
          style={{ fontSize: 15, fontWeight: 600, color: 'var(--tm-text-primary)', lineHeight: 1.4 }}
          title={game.name}
        >
          {game.name}
        </div>
        <div
          className="tm-clamp-1"
          style={{ fontSize: 12, color: 'var(--tm-text-secondary)', marginTop: 3 }}
        >
          {game.min_players}-{game.max_players} 人 · {game.play_time_text}
        </div>
        {!compact && (
          <div style={{ marginTop: 8, display: 'flex', gap: 4, flexWrap: 'wrap' }}>
            {game.categories.slice(0, 2).map((c) => (
              <span
                key={c}
                style={{
                  fontSize: 11,
                  lineHeight: '19px',
                  padding: '0 8px',
                  borderRadius: 7,
                  background: 'var(--tm-tint)',
                  color: 'var(--tm-link)',
                  whiteSpace: 'nowrap',
                }}
              >
                {c}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
