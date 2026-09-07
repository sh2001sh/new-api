package app

import (
	"fmt"
	"testing"
	"time"

	marketplaceschema "github.com/sh2001sh/new-api/internal/marketplace/schema"
	"github.com/stretchr/testify/require"
)

func TestMarketplaceGroupStatusReturnsAllVisibleGroupsBeyondFirstPage(t *testing.T) {
	db := openMarketplaceAppTestDB(t)
	require.NoError(t, db.AutoMigrate(&marketplaceschema.Group{}, &marketplaceschema.Channel{}, &marketplaceschema.GroupAccess{}, &marketplaceschema.RankingSnapshot{}))
	for i := 0; i < 127; i++ {
		id := fmt.Sprintf("status-%03d", i)
		group := marketplaceschema.Group{ID: id, ChannelID: id, PublicSlug: id, InternalGroupName: id,
			Visibility: "public", LifecycleStatus: "active", VerificationStatus: "passed", OwnerUserID: 20, Multiplier: 1}
		if i == 125 {
			group.Visibility = "private"
		}
		if i == 126 {
			group.LifecycleStatus = "disabled"
		}
		require.NoError(t, db.Create(&group).Error)
		require.NoError(t, db.Create(&marketplaceschema.Channel{ID: id, DeclaredModels: `["gpt-5.6"]`}).Error)
		require.NoError(t, db.Create(&marketplaceschema.RankingSnapshot{
			GroupID: id, WindowHours: 24, RankingVersion: rankingVersion, CalculatedAt: time.Now().UTC(),
			RequestCount: 20, RawSuccessRate: 95, CacheHitRate: 80,
		}).Error)
	}
	items, err := ListMarketplaceGroupStatus(0)
	require.NoError(t, err)
	require.Len(t, items, 125)
	ids := make(map[string]bool, len(items))
	for _, item := range items {
		ids[item.ID] = true
		require.Equal(t, float64(95), item.SuccessRate)
		require.Equal(t, []string{"gpt-5.6"}, item.Models)
	}
	require.True(t, ids["status-124"], "the third page must be included in the same response")
	require.False(t, ids["status-125"], "private groups must remain private")
	require.False(t, ids["status-126"], "disabled groups must stay excluded")
	require.NoError(t, db.Create(&marketplaceschema.GroupAccess{GroupID: "status-125", UserID: 10}).Error)
	items, err = ListMarketplaceGroupStatus(10)
	require.NoError(t, err)
	require.Len(t, items, 126, "invited users can see their private group")
	t.Log("125 public groups returned in one response; invited viewer receives 126")
}

func TestMarketplaceGroupStatusEmpty(t *testing.T) {
	db := openMarketplaceAppTestDB(t)
	require.NoError(t, db.AutoMigrate(&marketplaceschema.Group{}))
	items, err := ListMarketplaceGroupStatus(0)
	require.NoError(t, err)
	require.NotNil(t, items)
	require.Empty(t, items)
}
