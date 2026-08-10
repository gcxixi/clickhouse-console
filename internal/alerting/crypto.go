package alerting

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"errors"
)

type SecretCodec struct{ aead cipher.AEAD }

func NewSecretCodec(key []byte) (*SecretCodec, error) {
	if len(key) != 32 {
		return nil, errors.New("alerting encryption key must be 32 bytes")
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	return &SecretCodec{aead: aead}, nil
}

func (c *SecretCodec) Encrypt(value string) (string, error) {
	nonce := make([]byte, c.aead.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return "", err
	}
	sealed := c.aead.Seal(nonce, nonce, []byte(value), nil)
	return base64.RawStdEncoding.EncodeToString(sealed), nil
}

func (c *SecretCodec) Decrypt(value string) (string, error) {
	sealed, err := base64.RawStdEncoding.DecodeString(value)
	if err != nil || len(sealed) < c.aead.NonceSize() {
		return "", errors.New("invalid encrypted alerting secret")
	}
	plain, err := c.aead.Open(nil, sealed[:c.aead.NonceSize()], sealed[c.aead.NonceSize():], nil)
	if err != nil {
		return "", errors.New("invalid alerting encryption key or secret")
	}
	return string(plain), nil
}
