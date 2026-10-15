from pydantic import BaseModel, ConfigDict, Field


class GameCreate(BaseModel):
    name: str = Field(max_length=200)
    name_en: str | None = None
    description: str | None = None
    description_en: str | None = None
    cover_image: str | None = None
    min_players: int | None = None
    max_players: int | None = None
    play_time_minutes: int | None = None
    min_age: int | None = None
    complexity: float | None = Field(default=None, ge=1, le=5)
    categories: list[str] = []
    mechanics: list[str] = []
    publisher: str | None = None
    year_published: int | None = None
    bgg_id: int | None = None
    bgg_url: str | None = None
    designers: list[str] = []
    artists: list[str] = []
    min_playtime: int | None = None
    max_playtime: int | None = None
    admin_note: str | None = None


class GameUpdate(BaseModel):
    name: str | None = None
    name_en: str | None = None
    description: str | None = None
    description_en: str | None = None
    cover_image: str | None = None
    min_players: int | None = None
    max_players: int | None = None
    play_time_minutes: int | None = None
    min_age: int | None = None
    complexity: float | None = Field(default=None, ge=1, le=5)
    categories: list[str] | None = None
    mechanics: list[str] | None = None
    publisher: str | None = None
    year_published: int | None = None
    bgg_id: int | None = None
    bgg_url: str | None = None
    designers: list[str] | None = None
    artists: list[str] | None = None
    min_playtime: int | None = None
    max_playtime: int | None = None
    admin_note: str | None = None


class GameOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    name_en: str | None = None
    description: str | None = None
    description_en: str | None = None
    cover_image: str | None = None
    min_players: int | None = None
    max_players: int | None = None
    play_time_minutes: int | None = None
    min_age: int | None = None
    complexity: float | None = None
    categories: list = []
    mechanics: list = []
    publisher: str | None = None
    year_published: int | None = None
    avg_rating: float
    rating_count: int
    bgg_id: int | None = None
    bgg_url: str | None = None
    designers: list = []
    artists: list = []
    min_playtime: int | None = None
    max_playtime: int | None = None


class TagCreate(BaseModel):
    name: str = Field(max_length=100)
    type: str = Field(pattern="^(category|mechanic)$")


class TagOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    type: str
