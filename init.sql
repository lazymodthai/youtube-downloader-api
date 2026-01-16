-- Create usage_logs table
CREATE TABLE IF NOT EXISTS usage_logs (
    id SERIAL PRIMARY KEY,
    endpoint VARCHAR(50) NOT NULL,
    video_url TEXT,
    video_title TEXT,
    video_author TEXT,
    video_duration INTEGER,
    format VARCHAR(20),
    status VARCHAR(20) NOT NULL DEFAULT 'pending',
    error_message TEXT,
    processing_time_ms INTEGER,
    ip_address VARCHAR(45),
    user_agent TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    completed_at TIMESTAMP WITH TIME ZONE
);

-- Create index for faster queries
CREATE INDEX idx_usage_logs_endpoint ON usage_logs(endpoint);
CREATE INDEX idx_usage_logs_created_at ON usage_logs(created_at);
CREATE INDEX idx_usage_logs_status ON usage_logs(status);

-- Create summary_results table for storing AI summaries
CREATE TABLE IF NOT EXISTS summary_results (
    id SERIAL PRIMARY KEY,
    usage_log_id INTEGER REFERENCES usage_logs(id),
    video_url TEXT NOT NULL,
    video_title TEXT,
    summary TEXT,
    key_points JSONB,
    transcript_length INTEGER,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_summary_results_video_url ON summary_results(video_url);
