package store

import "testing"

func TestStoreUsersAndAdminInvariant(t *testing.T) {
	s, generated, err := Open(t.TempDir(), "admin", "")
	if err != nil {
		t.Fatal(err)
	}
	if len(generated) < 12 {
		t.Fatal("expected generated password")
	}
	admin, ok := s.Authenticate("admin", generated)
	if !ok {
		t.Fatal("bootstrap login failed")
	}
	u, err := s.CreateUser("reader", "a-secure-password", "viewer")
	if err != nil {
		t.Fatal(err)
	}
	disabled := true
	if _, err = s.UpdateUser(admin.ID, "", "", &disabled); err == nil {
		t.Fatal("last admin should not be disabled")
	}
	if _, err = s.UpdateUser(u.ID, "editor", "another-password", nil); err != nil {
		t.Fatal(err)
	}
	if got, ok := s.Authenticate("reader", "another-password"); !ok || got.Role != "editor" {
		t.Fatal("updated user login failed")
	}
}
