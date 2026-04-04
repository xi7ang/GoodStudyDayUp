-- 创建 pandata 表
CREATE TABLE IF NOT EXISTS pandata (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    resource_name TEXT NOT NULL,
    resource_description TEXT,
    resource_link TEXT,
    resource_hint TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 创建索引以提高查询性能
CREATE INDEX IF NOT EXISTS idx_pandata_id ON pandata(id);

-- 示例数据（可选）
-- INSERT INTO pandata (resource_name, resource_description, resource_link, resource_hint)
-- VALUES
--   ('示例资源1', '这是一个示例资源的描述', 'https://example.com/resource1', '使用提示：请先阅读说明'),
--   ('示例资源2', '另一个资源的详细描述', 'https://example.com/resource2', '注意：需要登录后访问');
