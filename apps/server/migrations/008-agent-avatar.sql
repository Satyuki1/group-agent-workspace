ALTER TABLE agents ADD COLUMN avatar text NOT NULL DEFAULT 'spark-rose';
WITH numbered AS (SELECT id, row_number() OVER (ORDER BY created_at,id)-1 AS n FROM agents)
UPDATE agents a SET avatar=(ARRAY['spark-rose','orbit-blue','pebble-mint','bloom-violet','spark-amber','orbit-prism'])[1+(numbered.n%6)::int]
FROM numbered WHERE a.id=numbered.id;
