ALTER TABLE jobs ADD COLUMN requested_clip_ranges TEXT
  CHECK(requested_clip_ranges IS NULL OR (
    json_valid(requested_clip_ranges) AND json_type(requested_clip_ranges) = 'array'
    AND json_array_length(requested_clip_ranges) BETWEEN 2 AND 3
    AND requested_operation = 'download' AND requested_mode = 'video'
    AND requested_start_seconds IS NULL AND requested_end_seconds IS NULL
  ));
ALTER TABLE video_quality_prompts ADD COLUMN requested_clip_ranges TEXT
  CHECK(requested_clip_ranges IS NULL OR (
    json_valid(requested_clip_ranges) AND json_type(requested_clip_ranges) = 'array'
    AND json_array_length(requested_clip_ranges) BETWEEN 2 AND 3
    AND trim_start_seconds IS NULL AND trim_end_seconds IS NULL
  ));
ALTER TABLE job_deliveries ADD COLUMN telegram_message_ids TEXT
  CHECK(telegram_message_ids IS NULL OR (
    json_valid(telegram_message_ids) AND json_type(telegram_message_ids) = 'array'
    AND json_array_length(telegram_message_ids) BETWEEN 2 AND 3
  ));
