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

-- ========== 全文搜索（FTS5）==========
-- 用于高效关键词搜索

CREATE VIRTUAL TABLE IF NOT EXISTS pandata_fts USING fts5(
  resource_name,
  resource_description,
  resource_link,
  content='pandata',
  content_rowid='id'
);

-- 增量同步触发器：新增时自动写入 FTS
CREATE TRIGGER IF NOT EXISTS pandata_fts_insert
AFTER INSERT ON pandata BEGIN
  INSERT INTO pandata_fts(rowid, resource_name, resource_description, resource_link)
  VALUES (new.id, new.resource_name, new.resource_description, new.resource_link);
END;

-- 增量同步触发器：删除时自动删除 FTS
CREATE TRIGGER IF NOT EXISTS pandata_fts_delete
AFTER DELETE ON pandata BEGIN
  INSERT INTO pandata_fts(pandata_fts, rowid, resource_name, resource_description, resource_link)
  VALUES ('delete', old.id, old.resource_name, old.resource_description, old.resource_link);
END;

-- 增量同步触发器：更新时自动更新 FTS
CREATE TRIGGER IF NOT EXISTS pandata_fts_update
AFTER UPDATE ON pandata BEGIN
  INSERT INTO pandata_fts(pandata_fts, rowid, resource_name, resource_description, resource_link)
  VALUES ('delete', old.id, old.resource_name, old.resource_description, old.resource_link);
  INSERT INTO pandata_fts(rowid, resource_name, resource_description, resource_link)
  VALUES (new.id, new.resource_name, new.resource_description, new.resource_link);
END;

-- 示例数据（可选）
-- INSERT INTO pandata (resource_name, resource_description, resource_link, resource_hint)
-- VALUES
--   ('示例资源1', '这是一个示例资源的描述', 'https://example.com/resource1', '使用提示：请先阅读说明'),
--   ('示例资源2', '另一个资源的详细描述', 'https://example.com/resource2', '注意：需要登录后访问');

-- 初始化迁移：把历史数据一次性导入 FTS 表（首次部署时执行一次即可）
-- INSERT INTO pandata_fts(rowid, resource_name, resource_description, resource_link)
-- SELECT id, resource_name, resource_description, resource_link FROM pandata;
