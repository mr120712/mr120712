package main

import "testing"

func TestHostAllowed(t *testing.T) {
	allowed := defaultAllowedDomains
	cases := map[string]bool{
		"https://www.youtube.com/watch?v=abc": true,
		"https://youtu.be/abc":                true,
		"https://music.youtube.com/watch?v=x": true,
		"https://m.youtube.com/watch?v=x":     true,
		"https://youtube.com/playlist?list=x": true,
		"https://evil-youtube.com/x":          false,
		"https://youtube.com.attacker.net/x":  false,
		"https://vimeo.com/123":               false,
		"not a url":                           false,
	}
	for input, want := range cases {
		if got := hostAllowed(input, allowed); got != want {
			t.Errorf("hostAllowed(%q) = %v, want %v", input, got, want)
		}
	}
}

func TestClampSpeed(t *testing.T) {
	if got := clampSpeed(5); got != maxSpeed {
		t.Errorf("clampSpeed(5) = %v, want %v", got, maxSpeed)
	}
	if got := clampSpeed(0.01); got != minSpeed {
		t.Errorf("clampSpeed(0.01) = %v, want %v", got, minSpeed)
	}
	if got := clampSpeed(1.1); got != 1.1 {
		t.Errorf("clampSpeed(1.1) = %v, want 1.1", got)
	}
}

func TestSpeedTag(t *testing.T) {
	cases := []struct {
		speed  float64
		reverb bool
		want   string
	}{
		{0.85, false, "slowed"},
		{1.25, false, "spedup"},
		{0.82, true, "slowed+reverb"},
		{1.2, true, "reverb"},
	}
	for _, c := range cases {
		if got := speedTag(c.speed, c.reverb); got != c.want {
			t.Errorf("speedTag(%v, %v) = %q, want %q", c.speed, c.reverb, got, c.want)
		}
	}
}
