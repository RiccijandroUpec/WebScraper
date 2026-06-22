DELETE FROM "Session" WHERE "instanceId" = (SELECT id FROM "Instance" WHERE name = 'kiosko');
DELETE FROM "Instance" WHERE name = 'kiosko';
